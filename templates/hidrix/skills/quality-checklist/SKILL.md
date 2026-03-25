# SKILL: Pre-Delivery Quality Checklist

## When to Use

- Before sending any report, analysis, or document to Son
- Before declaring a task "done"
- After completing multi-agent work

---

## Universal Checklist

### Content Quality

- [ ] **Every number has a source** or explicit `[estimate]` label
- [ ] **Math verified** with calculator (see skill-math-verify.md)
- [ ] **No hallucinated facts** — uncertain claims marked as such
- [ ] **"So What" exists** — each section has actionable insight

### Document Quality

- [ ] **Formatting consistent** — headers, lists, tables uniform
- [ ] **No markdown artifacts** in DOCX (raw `**bold**` etc.)
- [ ] **Tables render correctly** — checked in preview
- [ ] **Diagrams embedded** (not just linked) if DOCX

### Completeness

- [ ] **All requested sections present**
- [ ] **Table of contents matches content**
- [ ] **Executive summary reflects full document**
- [ ] **Appendix items referenced in main text**

### Meta

- [ ] **File saved** to correct location (outputs/)
- [ ] **Committed** to git
- [ ] **Uploaded** to Drive if requested
- [ ] **Logged** in memory/YYYY-MM-DD.md

---

## Report-Specific Checklist

### Market Analysis

- [ ] TAM, SAM, SOM all present with methodology
- [ ] Competitive matrix with scoring (not just listing)
- [ ] Data sources cited (not "industry reports")
- [ ] Both top-down and bottom-up sizing shown
- [ ] Conflicting sources acknowledged

### Sales Deck

- [ ] Problem → Solution → Why Us flow clear
- [ ] Specific numbers (not "significant growth")
- [ ] Case studies or proof points
- [ ] Clear CTA on final slide
- [ ] Fits in 10-15 slides

### Technical Documentation

- [ ] Code examples tested
- [ ] Commands copy-pasteable
- [ ] Prerequisites listed
- [ ] Diagrams explain architecture
- [ ] Glossary for jargon

---

## DOCX-Specific Checklist

- [ ] Cover page has: title, date, author, classification
- [ ] Page numbers present
- [ ] Headers/footers on content pages
- [ ] Tables use DXA units (not percentage)
- [ ] ShadingType.CLEAR (not SOLID)
- [ ] Images embedded, not linked
- [ ] File size reasonable (< 500KB for text, < 2MB with images)

---

## Pre-Send Verification

Before sending to Son:

```
1. Re-read executive summary — does it capture key points?
2. Spot-check 3 random numbers — are they sourced?
3. Open DOCX in preview — does it render correctly?
4. Check file size — is it reasonable?
5. Verify upload link works — click it yourself
```

---

## Post-Delivery

After Son reviews:

- [ ] Capture feedback in memory/YYYY-MM-DD.md
- [ ] Update relevant skills/templates if pattern identified
- [ ] Fix issues before next similar task

---

## Quick Reference Card

```
╔══════════════════════════════════════════╗
║         PRE-DELIVERY CHECKLIST           ║
╠══════════════════════════════════════════╣
║ □ Numbers sourced                        ║
║ □ Math verified                          ║
║ □ "So What" in each section              ║
║ □ Formatting clean                       ║
║ □ File saved + committed + uploaded      ║
║ □ Self-reviewed before send              ║
╚══════════════════════════════════════════╝
```

---

_Created: 2026-02-08_
_Use: Before every delivery to Son_
