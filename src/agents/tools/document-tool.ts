/**
 * Document Parsing tool: parse PDFs, spreadsheets, and images for agents.
 *
 * Perplexity Computer-style document intelligence. The agent can:
 * - Extract text from PDFs (using pdftotext if available, or raw buffer fallback)
 * - Parse CSV/TSV files into structured data
 * - Read plain text, JSON, markdown files
 * - Perform basic image OCR (via tesseract if available)
 *
 * All parsing happens locally — no data sent to external services.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("tools/document");
const execFileAsync = promisify(execFile);

const DOCUMENT_ACTIONS = ["parse", "info"] as const;
const DOCUMENT_TYPES = ["pdf", "csv", "tsv", "text", "json", "markdown", "auto"] as const;

const DocumentToolSchema = Type.Object({
  action: stringEnum(DOCUMENT_ACTIONS),
  /** Absolute or relative path to the document file */
  filePath: Type.String(),
  /** Document type (default: auto-detect from extension) */
  type: stringEnum(DOCUMENT_TYPES),
  /** For CSV: max rows to return (default: 100) */
  maxRows: Type.Optional(Type.Number({ minimum: 1, maximum: 10_000 })),
  /** Max characters of text to return (default: 50_000) */
  maxChars: Type.Optional(Type.Number({ minimum: 100, maximum: 500_000 })),
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

async function parsePdf(filePath: string, maxChars: number): Promise<string> {
  // Try pdftotext (poppler-utils) first — available on Ubuntu/Debian
  try {
    const { stdout } = await execFileAsync("pdftotext", [filePath, "-"], { timeout: 30_000 });
    return truncate(stdout, maxChars);
  } catch {
    log.debug("pdftotext not available, trying raw text extraction");
  }

  // Fallback: read raw bytes and extract printable text (crude but works for simple PDFs)
  const buf = fs.readFileSync(filePath);
  const raw = buf.toString("latin1");
  const extracted = raw
    .replace(/[^\x20-\x7E\n\t]/g, " ")
    .replace(/\s{3,}/g, "\n")
    .trim();

  if (extracted.length < 50) {
    return "[PDF parsing failed: pdftotext not installed. Install poppler-utils: sudo apt install poppler-utils]";
  }

  return truncate(extracted, maxChars);
}

function parseCsv(filePath: string, maxRows: number, separator = ","): string {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.trim().split("\n").slice(0, maxRows + 1);
  if (lines.length === 0) return "[Empty file]";

  const header = lines[0];
  const rows = lines.slice(1);
  const cols = header.split(separator).length;

  return [
    `Headers: ${header}`,
    `Columns: ${cols}`,
    `Rows shown: ${rows.length}${rows.length === maxRows ? " (truncated)" : ""}`,
    "",
    lines.join("\n"),
  ].join("\n");
}

function parseJson(filePath: string, maxChars: number): string {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    const pretty = JSON.stringify(parsed, null, 2);
    return truncate(pretty, maxChars);
  } catch (err) {
    return `[JSON parse error: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

function parseText(filePath: string, maxChars: number): string {
  const content = fs.readFileSync(filePath, "utf8");
  return truncate(content, maxChars);
}

async function parseImage(filePath: string): Promise<string> {
  // Try tesseract-ocr if available
  try {
    const { stdout } = await execFileAsync("tesseract", [filePath, "stdout"], {
      timeout: 60_000,
    });
    return stdout.trim() || "[No text detected in image]";
  } catch {
    return "[OCR not available: install tesseract-ocr with: sudo apt install tesseract-ocr]";
  }
}

function detectType(filePath: string): (typeof DOCUMENT_TYPES)[number] {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  switch (ext) {
    case "pdf": return "pdf";
    case "csv": return "csv";
    case "tsv": return "tsv";
    case "json": return "json";
    case "md":
    case "mdx": return "markdown";
    case "txt":
    case "text": return "text";
    default: return "text";
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[... truncated at ${max} chars]`;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createDocumentTool(): AnyAgentTool {
  return {
    label: "Document Parser",
    name: "document_parse",
    description:
      "Parse documents and files. Supports PDF (text extraction), CSV/TSV (tabular data), " +
      "JSON, plain text, and Markdown. Use action=info to see file metadata, " +
      "action=parse to extract the content.",
    parameters: DocumentToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as "parse" | "info";
      const filePath = readStringParam(params, "filePath", { required: true });
      const maxRowsRaw = typeof params.maxRows === "number" ? params.maxRows : 100;
      const maxRows = Math.min(10_000, Math.max(1, Math.floor(maxRowsRaw)));
      const maxCharsRaw = typeof params.maxChars === "number" ? params.maxChars : 50_000;
      const maxChars = Math.min(500_000, Math.max(100, Math.floor(maxCharsRaw)));

      // Validate file exists
      if (!fs.existsSync(filePath)) {
        return jsonResult({ status: "error", error: `File not found: ${filePath}` });
      }

      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return jsonResult({ status: "error", error: `Not a file: ${filePath}` });
      }

      const rawType = readStringParam(params, "type") as (typeof DOCUMENT_TYPES)[number] ?? "auto";
      const type = rawType === "auto" ? detectType(filePath) : rawType;

      if (action === "info") {
        return jsonResult({
          status: "ok",
          file_path: filePath,
          file_name: path.basename(filePath),
          extension: path.extname(filePath),
          detected_type: type,
          size_bytes: stat.size,
          size_kb: Math.round(stat.size / 1024),
          modified_at: new Date(stat.mtimeMs).toISOString(),
        });
      }

      // action === "parse"
      let content: string;
      try {
        switch (type) {
          case "pdf":
            content = await parsePdf(filePath, maxChars);
            break;
          case "csv":
            content = parseCsv(filePath, maxRows);
            break;
          case "tsv":
            content = parseCsv(filePath, maxRows, "\t");
            break;
          case "json":
            content = parseJson(filePath, maxChars);
            break;
          case "text":
          case "markdown":
          default:
            content = parseText(filePath, maxChars);
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ status: "error", error: `Parse failed: ${message}` });
      }

      return jsonResult({
        status: "ok",
        file_path: filePath,
        type,
        size_bytes: stat.size,
        content_length: content.length,
        content,
      });
    },
  };
}
