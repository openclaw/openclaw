import csvToMarkdown from "csv-to-markdown-table";
import type { InputFileLimits } from "../../media/input-files.js";
import { extractPdfContent } from "../../media/input-files.js";

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

import type { SessionFileType } from "./types.js";

export async function convertToMarkdown(
  buffer: Buffer,
  type: SessionFileType,
  _filename: string,
): Promise<string> {
  switch (type) {
    case "csv": {
      const text = buffer.toString("utf-8");
      return csvToMarkdownTable(text);
    }
    case "json": {
      const text = buffer.toString("utf-8");
      return jsonToMarkdown(text);
    }
    case "text": {
      const text = buffer.toString("utf-8");
      return textToMarkdown(text);
    }
    case "pdf": {
      // Extract PDF text first
      const limits: InputFileLimits = {
        allowUrl: false,
        allowedMimes: new Set(["application/pdf"]),
        maxBytes: 50 * 1024 * 1024, // 50MB default
        maxChars: 1_000_000, // 1M chars default
        maxRedirects: 5,
        timeoutMs: 30_000,
        pdf: {
          maxPages: 100, // Reasonable default
          maxPixels: 10_000_000, // 10MP default
          minTextChars: 10,
        },
      };
      const extracted = await extractPdfContent({ buffer, limits });
      const pdfText = extracted.text || "";
      return pdfToMarkdown(pdfText, false);
    }
    default: {
      const text = buffer.toString("utf-8");
      return text;
    }
  }
}
