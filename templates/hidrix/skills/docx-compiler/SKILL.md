# SKILL: Compile Markdown → Professional DOCX

## When to Use

- User provides markdown files and wants a compiled .docx report
- User asks for "professional document", "Word doc", "formatted report"
- After completing a multi-chapter writing task

## Prerequisites

```bash
npm install -g docx   # Node.js docx-js library
```

Verify: `node -e "require('docx')" && echo "OK"`

## Architecture

```
Input: folder of .md files
         ↓
Step 1: Inventory (list files, word counts, define order)
         ↓
Step 2: Write build script (single Node.js file)
         ↓
Step 3: Run script → .docx output
         ↓
Step 4: Validate → Fix if needed → Deliver
```

Everything happens in ONE Node.js script. Do not use multiple scripts.

## Build Script Structure

```javascript
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  Header,
  Footer,
  AlignmentType,
  LevelFormat,
  HeadingLevel,
  BorderStyle,
  WidthType,
  ShadingType,
  PageBreak,
  PageNumber,
} = require("docx");

// 1. CONFIG
const COLORS = {
  primary: "1B365D", // Dark navy — headings, titles
  accent: "2E86AB", // Teal — subheadings, links
  tableHeader: "1B365D", // Table header background
  tableHeaderText: "FFFFFF", // Table header text
  tableAlt: "F7F9FB", // Alternating row
  border: "D1D5DB", // Table borders
  text: "333333", // Body text
  subtle: "6B7280", // Footer, meta text
  code: "F3F4F6", // Code block background
};

const FONT = "Arial";
const PAGE_WIDTH = 12240; // US Letter 8.5" in DXA
const PAGE_HEIGHT = 15840; // US Letter 11" in DXA
const MARGIN = 1440; // 1 inch
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN; // 9360 DXA

// 2. CHAPTER ORDER — always define explicitly, never glob
const CHAPTERS = [
  "ch01-intro.md",
  "ch02-analysis.md",
  // ...
];

// 3. MARKDOWN PARSER — converts .md lines to typed elements
function parseMarkdown(md) {
  // Returns: [{type: 'h1', content: '...'}, {type: 'table', rows: [[...]]}, ...]
  // Types: h1, h2, h3, h4, paragraph, bullet, numbered, table, code
}

// 4. INLINE PARSER — handles **bold**, `code`, *italic* inside text
function parseInline(text) {
  // Returns: [TextRun({bold: true}), TextRun({font: 'Courier New'}), ...]
}

// 5. ELEMENT BUILDERS
function buildTable(rows) {
  /* → Table object */
}
function buildCodeBlock(code) {
  /* → array of Paragraph objects */
}
function elementsToDocx(elements) {
  /* routes each element type to builder */
}

// 6. SPECIAL PAGES
function buildCoverPage() {
  /* title, branding, date, classification */
}
function buildTOC() {
  /* table of contents */
}

// 7. ASSEMBLE
const doc = new Document({
  styles: {
    /* heading styles with outlineLevel */
  },
  numbering: {
    /* bullet + number configs */
  },
  sections: [
    { children: coverPage }, // No header/footer
    { children: toc }, // No header/footer
    { children: chapters, headers: {}, footers: {} }, // With header/footer
  ],
});
```

## Markdown Parser Rules

| Markdown        | Detect By                    | Output Type |
| --------------- | ---------------------------- | ----------- | --- | ---------------- | ------------------------------ | --- | ----- |
| `# Title`       | `line.match(/^#\s+/)`        | h1          |
| `## Section`    | `line.match(/^##\s+/)`       | h2          |
| `### Sub`       | `line.match(/^###\s+/)`      | h3          |
| `- item`        | `line.match(/^\s*[-*]\s+/)`  | bullet      |
| `1. item`       | `line.match(/^\s*\d+\.\s+/)` | numbered    |
| `               | col                          | col         | `   | `line.includes(' | ') && line.trim().startsWith(' | ')` | table |
| ` ``` `         | Fenced block                 | code        |
| Everything else | Non-empty line               | paragraph   |

**Table parsing**: Skip separator rows (`|---|---|`). Split by `|`, trim, ignore first and last empty splits.

## Critical docx-js Rules

### MUST DO

- **Set page size explicitly**: Default is A4, usually want US Letter (12240 × 15840)
- **Tables: set BOTH `columnWidths` on Table AND `width` on each TableCell** — without both, rendering breaks
- **Table width = sum of columnWidths = CONTENT_WIDTH**
- **Use `WidthType.DXA` always** — NEVER `WidthType.PERCENTAGE` (breaks Google Docs)
- **Use `ShadingType.CLEAR`** — NEVER `ShadingType.SOLID` (causes black backgrounds)
- **Use `LevelFormat.BULLET` with numbering config** for bullet points
- **Add `outlineLevel` to heading styles** (0 for H1, 1 for H2) — required for TOC
- **Cell margins**: `{ top: 60, bottom: 60, left: 100, right: 100 }` for readable padding
- **Separate sections** for cover page (no header) vs content (with header/footer)

### NEVER DO

- **Never use `\n`** in text — use separate Paragraph elements
- **Never use unicode bullets** (`•`, `\u2022`) — use numbering config
- **Never nest TextRun inside TextRun** — causes `<w:r><w:r>` XML error
- **Never put PageBreak as nested child** — must be direct: `new TextRun({ children: [new PageBreak()] })`

## Validation & Fix Pipeline

```bash
# Step 1: Validate
python validate.py report.docx

# If PASSED → done, deliver file
# If FAILED → fix:
python unpack.py report.docx unpacked/    # Extract to XML
# Read error message, find problem in unpacked/word/document.xml
# Common fix: nested <w:r> tags from PageBreak
# Fix with sed/python regex
python pack.py unpacked/ report.docx --original report.docx
python validate.py report.docx            # Re-validate
```

### Common Validation Errors

| Error                      | Cause                                 | Fix                           |
| -------------------------- | ------------------------------------- | ----------------------------- |
| `element w:r not expected` | Nested `<w:r><w:r>`                   | Regex: flatten nested runs    |
| `black table cells`        | `ShadingType.SOLID`                   | Change to `ShadingType.CLEAR` |
| `table width wrong`        | columnWidths don't sum to table width | Recalculate                   |

## Design Standards

| Element       | Spec                                       |
| ------------- | ------------------------------------------ |
| Body font     | Arial 11pt (size: 22 in half-points)       |
| H1            | Arial 18pt bold, navy (#1B365D)            |
| H2            | Arial 14pt bold, navy                      |
| H3            | Arial 12pt bold, teal (#2E86AB)            |
| Code          | Courier New 8pt, gray background (#F3F4F6) |
| Table header  | Navy background, white text, bold          |
| Table rows    | Alternating white / light gray (#F7F9FB)   |
| Table borders | Light gray (#D1D5DB), 1pt                  |
| Page margins  | 1 inch all sides                           |
| Header        | Report title, right-aligned, italic, gray  |
| Footer        | "Company Name • Page X", centered, gray    |

## Output Checklist

Before delivering, verify:

- [ ] Cover page has title, author, date, branding
- [ ] TOC lists all chapters and appendixes
- [ ] Each chapter starts on new page
- [ ] Tables render correctly (no black cells, proper widths)
- [ ] Headers/footers appear on content pages only
- [ ] Validation passes with no errors
- [ ] File size reasonable (100-300KB for 30K+ word report)

---

_Source: Son, 2026-02-08_
