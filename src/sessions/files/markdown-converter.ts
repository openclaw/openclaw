import csvToMarkdown from "csv-to-markdown-table";

export function csvToMarkdownTable(csv: string): string {
  if (!csv.trim()) {
    return "";
  }

  // Use csv-to-markdown-table library
  // Parameters: csvString, delimiter (default ','), hasHeaders (default true)
  const result = csvToMarkdown(csv, ",", true);
  // Trim trailing whitespace and newlines
  return result.trimEnd();
}

export function jsonToMarkdown(json: string): string {
  // Try to format JSON if valid, otherwise use as-is
  let formatted = json;
  try {
    const parsed = JSON.parse(json);
    formatted = JSON.stringify(parsed, null, 2);
  } catch {
    // Invalid JSON, use as-is
    formatted = json;
  }
  return `\`\`\`json\n${formatted}\n\`\`\``;
}

function looksLikeMarkdown(text: string): boolean {
  // Simple heuristic: check for common markdown patterns
  const markdownPatterns = [
    /^#{1,6}\s+/m, // Headers
    /\*\*.*\*\*/, // Bold
    /\*.*\*/m, // Italic
    /\[.*\]\(.*\)/, // Links
    /^\s*[-*+]\s+/m, // Lists
    /^\s*\d+\.\s+/m, // Numbered lists
    /```/, // Code blocks
    /^\s*\|.*\|/m, // Tables
  ];
  return markdownPatterns.some((pattern) => pattern.test(text));
}

export function textToMarkdown(text: string): string {
  if (!text.trim()) {
    return "";
  }
  // If it looks like markdown, keep as-is
  if (looksLikeMarkdown(text)) {
    return text;
  }
  // Otherwise wrap in code block
  return `\`\`\`\n${text}\n\`\`\``;
}

export function pdfToMarkdown(pdfText: string, pageBreaks: boolean): string {
  if (!pdfText.trim()) {
    return "";
  }
  if (!pageBreaks) {
    return pdfText;
  }
  // Simple approach: add page break markers (actual PDF extraction handles pages)
  // For now, just return text as-is since extractPdfContent already handles pages
  return pdfText;
}
