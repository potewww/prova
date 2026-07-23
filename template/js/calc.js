// ============================================================
// calc.js — porting fedele della logica Lua (calcoli.tex + cene/calcolicene.tex)
// + gestione arrotondamenti equi (centesimini) e riconciliazione automatica (solata)
// ============================================================

const CAT_CIBO = ["antipasto", "primi", "secondi", "contorni", "pizza", "panini", "frutta"];
const CAT_BEVANDE = ["acqua", "caffe", "bibite", "birra", "vino", "liquori"];
const CAT_ALTRO = ["centesimini", "solata", "menu", "coperto", "dolci"];
const CAT_ALL = [...CAT_CIBO, ...CAT_BEVANDE, ...CAT_ALTRO];

// "solata" e "centesimini" non sono dati inseribili manualmente: vengono calcolati
// automaticamente (vedi applicaSolataAutomatica e la logica di arrotondamento equo).
// Vanno quindi esclusi dai campi del form e dal totale "di base" della persona,
// ma restano colonne normali ai fini di stampa/sconti.
const CAT_INPUT = CAT_ALL.filter(c => c !== "solata" && c !== "centesimini");

const CAT_LABELS = {
  antipasto: "Antipasto", primi: "Primi", secondi: "Secondi", contorni: "Contorni",
  pizza: "Pizza", panini: "Panini", frutta: "Frutta",
  acqua: "Acqua", caffe: "Caffè", bibite: "Bibite", birra: "Birra", vino: "Vino", liquori: "Liquori",
  centesimini: "Centesimini (auto)", solata: "Solata (auto)", menu: "Menù", coperto: "Coperto", dolci: "Dolci"
};

function applicaSconto(valore, categoria, sconti) {
  const s = (sconti && sconti[categoria]) || 0;
  if (s > 0) return valore * (1 - s / 100);
  return valore;
}

// Somma le sole categorie "di base" inserite a mano per la persona (esclude "solata")
function totaleConSconti(p, sconti) {
  return CAT_INPUT.reduce((sum, c) => sum + applicaSconto(p[c] || 0, c, sconti), 0);
}

function totaleSenzaSconti(p) {
  return CAT_INPUT.reduce((sum, c) => sum + (p[c] || 0), 0);
}

// Divide "importo" in "n" quote uguali arrotondate PER DIFETTO al centesimo, restituendo
// anche il resto (in euro, sempre < 0.01 * n) che non è stato possibile distribuire in modo
// equo. Il resto va assegnato a chi sta spendendo di meno (vedi chiamanti).
function dividiInParti(importo, n) {
  if (!n || n <= 0) return { shares: [], resto: importo };
  const totCent = Math.round(importo * 100);
  const baseCent = Math.floor(totCent / n);
  const shares = new Array(n).fill(baseCent / 100);
  const restoCent = totCent - baseCent * n;
  return { shares, resto: Math.round(restoCent) / 100 };
}

// Calcola, per una cena, le quote derivanti dalle spese condivise, con arrotondamento equo:
// se una spesa "divisa" non si divide esattamente in centesimi, la parte non assegnabile
// viene aggiunta alla colonna "centesimini" della persona (tra i partecipanti a quella spesa)
// che, al momento del calcolo, sta spendendo meno.
// Restituisce { quoteColonna: {nome: {categoria: importo}}, quoteSeparate: {nome: {descrizione: importo}} }
function calcolaQuoteCondivise(persone, speseCondivise, sconti) {
  const quoteColonna = {};
  const quoteSeparate = {};
  const totaleCorrente = {};
  persone.forEach(p => {
    quoteColonna[p.nome] = {};
    quoteSeparate[p.nome] = {};
    totaleCorrente[p.nome] = totaleConSconti(p, sconti || {});
  });

  function assegna(nome, spesa, valore) {
    if (spesa.colonna) {
      if (quoteColonna[nome] !== undefined) {
        quoteColonna[nome][spesa.colonna] = (quoteColonna[nome][spesa.colonna] || 0) + valore;
      }
    } else {
      if (quoteSeparate[nome] !== undefined) quoteSeparate[nome][spesa.descrizione] = valore;
    }
    if (totaleCorrente[nome] !== undefined) {
      totaleCorrente[nome] += spesa.colonna ? applicaSconto(valore, spesa.colonna, sconti || {}) : valore;
    }
  }

  (speseCondivise || []).forEach(spesa => {
    let part = (spesa.partecipanti && spesa.partecipanti.length) ? spesa.partecipanti : persone.map(p => p.nome);
    part = part.filter(nome => totaleCorrente[nome] !== undefined);
    if (part.length === 0) return;

    if (spesa.tipo === "divisa") {
      const { shares, resto } = dividiInParti(spesa.importo, part.length);
      part.forEach((nome, i) => assegna(nome, spesa, shares[i]));
      if (resto > 0.001) {
        let minNome = part[0];
        part.forEach(nome => { if (totaleCorrente[nome] < totaleCorrente[minNome]) minNome = nome; });
        quoteColonna[minNome]["centesimini"] = (quoteColonna[minNome]["centesimini"] || 0) + resto;
        totaleCorrente[minNome] += resto;
      }
    } else if (spesa.tipo === "persona") {
      part.forEach(nome => assegna(nome, spesa, spesa.importo));
    }
  });

  return { quoteColonna, quoteSeparate };
}

// Totale dovuto da una persona in una cena (cibo/bevande/altro + quote condivise, con sconti)
function dovutoCena(p, sconti, quoteColonna, quoteSeparate) {
  let t = totaleConSconti(p, sconti);
  const qc = quoteColonna[p.nome] || {};
  const qs = quoteSeparate[p.nome] || {};
  for (const colonna in qc) t += applicaSconto(qc[colonna], colonna, sconti);
  for (const desc in qs) t += qs[desc];
  return t;
}

// "Solata": riconciliazione automatica. Se il totale pagato al tavolo supera il totale
// dovuto calcolato (cibo+bevande+altro+condivise), la differenza viene ridistribuita in
// modo equo tra tutti i partecipanti alla cena (colonna "solata"), con lo stesso criterio
// di arrotondamento equo usato per le spese condivise. Se invece si è pagato meno o uguale,
// "solata" resta a zero (non viene creato un debito automatico).
function applicaSolataAutomatica(persone, sconti, quoteColonna, quoteSeparate) {
  if (persone.length === 0) return;
  const dovutoBase = {};
  persone.forEach(p => { dovutoBase[p.nome] = dovutoCena(p, sconti, quoteColonna, quoteSeparate); });

  const totgen = Object.values(dovutoBase).reduce((a, b) => a + b, 0);
  const totpagato = persone.reduce((a, p) => a + (p.pagato || 0), 0);
  const surplus = totpagato - totgen;
  if (surplus <= 0.005) return;

  const { shares, resto } = dividiInParti(surplus, persone.length);
  persone.forEach((p, i) => {
    quoteColonna[p.nome]["solata"] = (quoteColonna[p.nome]["solata"] || 0) + shares[i];
    dovutoBase[p.nome] += shares[i];
  });
  if (resto > 0.001) {
    let minNome = persone[0].nome;
    persone.forEach(p => { if (dovutoBase[p.nome] < dovutoBase[minNome]) minNome = p.nome; });
    quoteColonna[minNome]["centesimini"] = (quoteColonna[minNome]["centesimini"] || 0) + resto;
  }
}

// Calcola tutte le quote di una cena (condivise + solata automatica): usata da chiunque
// abbia bisogno dello stato completo di una cena (registro spese, dettaglio cena).
function calcolaQuoteComplete(cena) {
  const { quoteColonna, quoteSeparate } = calcolaQuoteCondivise(cena.persone, cena.speseCondivise, cena.sconti);
  applicaSolataAutomatica(cena.persone, cena.sconti, quoteColonna, quoteSeparate);
  return { quoteColonna, quoteSeparate };
}

// Genera le "spese NE" (Non Equo) da integrare nel registro spese generale,
// una per ogni persona che ha anticipato (pagato > 0) nella cena. Tutte le voci
// generate per la STESSA cena condividono lo stesso gruppoId: è fondamentale per
// calcolaStatoGlobale, che deve contare la quota dovuta (quote) una sola volta per
// cena e non una volta per ciascuna persona che ha anticipato (vedi più sotto).
function integraCenaInSpese(cena, gruppoId) {
  const { quoteColonna, quoteSeparate } = calcolaQuoteComplete(cena);
  const nomiCena = cena.persone.map(p => p.nome);
  const quoteCena = {};
  cena.persone.forEach(p => {
    quoteCena[p.nome] = dovutoCena(p, cena.sconti, quoteColonna, quoteSeparate);
  });

  const nuoveSpese = [];
  cena.persone.forEach(p => {
    if (p.pagato > 0) {
      nuoveSpese.push({
        nome: p.nome,
        descrizione: cena.titolo + " [NE]",
        importo: p.pagato,
        partecipanti: [...nomiCena],
        quote: { ...quoteCena },
        gruppoId: gruppoId
      });
    }
  });
  return nuoveSpese;
}

// Divide una spesa "semplice" (non di cena) tra i suoi partecipanti con arrotondamento
// equo: ogni quota è arrotondata per difetto al centesimo, il resto va a chi tra i
// partecipanti sta spendendo meno al momento (in base allo stato accumulato finora).
function ripartisciSpesaSemplice(s, part, spesaEffettivaCorrente) {
  const { shares, resto } = dividiInParti(s.importo, part.length);
  const risultato = {};
  part.forEach((nome, i) => { risultato[nome] = shares[i]; });
  if (resto > 0.001) {
    let minNome = part[0];
    part.forEach(nome => {
      const cur = spesaEffettivaCorrente[nome] || 0;
      if (cur < (spesaEffettivaCorrente[minNome] || 0)) minNome = nome;
    });
    risultato[minNome] += resto;
  }
  return risultato;
}

// Pipeline completa: dato (persone, speseBase, rimborsi, cene) calcola tutto lo stato globale.
function calcolaStatoGlobale(persone, speseBase, rimborsiData, ceneData) {
  const nomi = [...persone].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  // 1. aggiungi le spese "NE" derivanti da ogni cena, nell'ordine in cui compaiono
  let spese = [...speseBase];
  ceneData.forEach((cena, idx) => {
    spese = spese.concat(integraCenaInSpese(cena, `__cena_${idx}`));
  });

  // 2. totale pagato da ciascuno (somma di tutte le spese anticipate)
  const totaliPersona = {};
  nomi.forEach(n => totaliPersona[n] = 0);
  spese.forEach(s => {
    if (totaliPersona[s.nome] !== undefined) totaliPersona[s.nome] += s.importo;
  });

  // 3. spesa effettiva (quota dovuta) di ciascuno, con arrotondamento equo sulle spese divise
  //    IMPORTANTE: quando una spesa (o una cena) ha più persone che hanno anticipato i soldi,
  //    viene salvata come più voci nel registro (una per pagatore), ma tutte condividono lo
  //    stesso gruppoId e la STESSA mappa "quote" (quanto ciascuno deve in totale per quella
  //    spesa/cena). Va quindi sommata una sola volta per gruppo, non una volta per voce,
  //    altrimenti il dovuto di ognuno verrebbe moltiplicato per il numero di persone che hanno
  //    anticipato soldi per quella spesa.
  const spesaEffettiva = {};
  nomi.forEach(n => spesaEffettiva[n] = 0);
  const gruppiQuoteGiaContati = new Set();
  // Parallelo a "spese": per ciascuna voce, le quote realmente calcolate per ciascun
  // partecipante (utile per mostrare il dettaglio "chi deve quanto" per ogni spesa/cena
  // nella scheda "Spese in dettaglio", con la STESSA logica di arrotondamento usata qui).
  const dettaglioSpese = [];
  spese.forEach((s, i) => {
    if (s.quote) {
      const gid = s.gruppoId || `__voce_singola_${i}`;
      if (!gruppiQuoteGiaContati.has(gid)) {
        gruppiQuoteGiaContati.add(gid);
        for (const nome in s.quote) {
          if (spesaEffettiva[nome] !== undefined) spesaEffettiva[nome] += s.quote[nome];
        }
      }
      dettaglioSpese.push({ ...s, quoteCalcolate: s.quote });
    } else {
      const part = ((s.partecipanti && s.partecipanti.length) ? s.partecipanti : nomi).filter(n => spesaEffettiva[n] !== undefined);
      const quote = ripartisciSpesaSemplice(s, part, spesaEffettiva);
      part.forEach(p => { spesaEffettiva[p] += quote[p]; });
      dettaglioSpese.push({ ...s, quoteCalcolate: quote });
    }
  });

  const totaleGenerale = Object.values(totaliPersona).reduce((a, b) => a + b, 0);

  // 4. saldi = pagato - dovuto + rimborsi dati - rimborsi ricevuti
  //    (derivato direttamente da spesaEffettiva, per garantire coerenza esatta con essa)
  const saldi = {};
  nomi.forEach(n => saldi[n] = (totaliPersona[n] || 0) - (spesaEffettiva[n] || 0));
  rimborsiData.forEach(r => {
    if (saldi[r.da] !== undefined) saldi[r.da] += r.importo;
    if (saldi[r.a] !== undefined) saldi[r.a] -= r.importo;
  });

  // 5. rimborsi effettuati per persona (dati / ricevuti)
  const rimborsatoDA = {}, rimborsatoA = {};
  nomi.forEach(n => { rimborsatoDA[n] = 0; rimborsatoA[n] = 0; });
  rimborsiData.forEach(r => {
    if (rimborsatoDA[r.da] !== undefined) rimborsatoDA[r.da] += r.importo;
    if (rimborsatoA[r.a] !== undefined) rimborsatoA[r.a] += r.importo;
  });

  // 6. transazioni ottimizzate per pareggiare i conti
  const transazioni = calcolaTransazioni(saldi);

  return { nomi, spese, dettaglioSpese, totaliPersona, spesaEffettiva, totaleGenerale, saldi, rimborsatoDA, rimborsatoA, transazioni };
}

function calcolaTransazioni(saldi) {
  const debitori = [];
  const creditori = [];
  for (const nome in saldi) {
    const s = saldi[nome];
    if (s < -0.01) debitori.push({ nome, importo: -s });
    else if (s > 0.01) creditori.push({ nome, importo: s });
  }
  debitori.sort((a, b) => a.nome.toLowerCase().localeCompare(b.nome.toLowerCase()));
  creditori.sort((a, b) => a.nome.toLowerCase().localeCompare(b.nome.toLowerCase()));

  const transazioni = [];
  let iD = 0, iC = 0;
  while (iD < debitori.length && iC < creditori.length) {
    const d = debitori[iD], c = creditori[iC];
    const imp = Math.min(d.importo, c.importo);
    if (imp > 0.01) transazioni.push({ da: d.nome, a: c.nome, importo: imp });
    d.importo -= imp;
    c.importo -= imp;
    if (d.importo < 0.01) iD++;
    if (c.importo < 0.01) iC++;
  }
  return transazioni;
}

// Calcolo dettagliato "tabellaTotali"/"tabellaRimborsi" per una singola cena
function calcolaDettaglioCena(cena) {
  const { quoteColonna, quoteSeparate } = calcolaQuoteComplete(cena);
  const righe = cena.persone.map(p => {
    const dovuto = dovutoCena(p, cena.sconti, quoteColonna, quoteSeparate);
    const dovutoSenzaSconti = totaleSenzaSconti(p) +
      Object.values(quoteColonna[p.nome] || {}).reduce((a, b) => a + b, 0) +
      Object.values(quoteSeparate[p.nome] || {}).reduce((a, b) => a + b, 0);
    const saldo = p.pagato - dovuto;
    return { nome: p.nome, dovuto, dovutoSenzaSconti, pagato: p.pagato, saldo };
  });

  const totgen = righe.reduce((a, r) => a + r.dovuto, 0);
  const totgenSenzaSconti = righe.reduce((a, r) => a + r.dovutoSenzaSconti, 0);
  const totpagato = righe.reduce((a, r) => a + r.pagato, 0);
  const hasSconti = Object.values(cena.sconti).some(v => v > 0);

  // transazioni interne alla cena (usa le spese condivise proprie della cena — fix di un bug
  // presente nell'originale, che usava sempre le speseCondivise dell'ULTIMA cena caricata)
  const saldiCena = {};
  righe.forEach(r => saldiCena[r.nome] = r.saldo);
  const transazioniCena = calcolaTransazioni(saldiCena);

  return { righe, totgen, totgenSenzaSconti, totpagato, hasSconti, transazioniCena, quoteColonna, quoteSeparate };
}
