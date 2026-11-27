const auditHash = "0123456789abcdef".repeat(4);
const auditHeader = ["File", "Bytes", "SHA-256", "First nonempty line"];
const auditRows = [
  [
    "café_雪_invoice_reconciliation.md",
    "3514",
    auditHash,
    "Invoice arithmetic uses integer cents.",
  ],
];
export const auditMarkdownTable = [auditHeader, auditHeader.map(() => "---"), ...auditRows]
  .map((row) => `| ${row.join(" | ")} |`)
  .join("\n");
