import { spawnSync } from "node:child_process";
// Bounded local-file summaries for project document prompt context.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { ProjectDocumentRecord } from "./project-types.js";

const SUMMARY_MIN_CHARS = 1_400;
const SUMMARY_MAX_CHARS = 1_200;
const SUMMARY_READ_BYTES = 96 * 1024;
const SUMMARY_BINARY_MAX_BYTES = 20 * 1024 * 1024;
const SUMMARY_EXTRACT_TIMEOUT_MS = 10_000;
const SUMMARY_PDF_MAX_PAGES = 20;
const SUMMARY_TEXT_EXTENSIONS = new Set([".csv", ".json", ".md", ".mdx", ".txt", ".yaml", ".yml"]);
const SUMMARY_EXTRACTABLE_EXTENSIONS = new Set([...SUMMARY_TEXT_EXTENSIONS, ".pdf", ".docx"]);

export type ProjectDocumentSummaryDiagnosticStatus =
  | "summarized"
  | "eligible"
  | "not_needed"
  | "unsupported"
  | "remote"
  | "missing"
  | "unreadable";

export type ProjectDocumentSummaryCacheStatus = "hit" | "missing" | "stale" | "not_applicable";

export type ProjectDocumentSummaryUriKind = "none" | "local" | "file" | "obsidian" | "remote";

export type ProjectDocumentSummaryDiagnostic = {
  status: ProjectDocumentSummaryDiagnosticStatus;
  label: string;
  reason: string;
  uriKind: ProjectDocumentSummaryUriKind;
  cache: ProjectDocumentSummaryCacheStatus;
  injectsSummary: boolean;
  filePath?: string;
  extension?: string;
  sizeBytes?: number;
  mtimeMs?: number;
};

type ProjectDocumentText = {
  text: string;
  source: "text" | "pdf" | "docx";
  truncated: boolean;
};

type ProjectDocumentSummaryCacheDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "project_document_summary_cache"
>;

function getProjectDocumentSummaryCacheKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<ProjectDocumentSummaryCacheDatabase>(db);
}

export function summarizeProjectDocument(document: ProjectDocumentRecord): string | undefined {
  const filePath = resolveLocalDocumentPath(document.uri);
  const extension = filePath ? path.extname(filePath).toLowerCase() : "";
  if (!filePath || !SUMMARY_EXTRACTABLE_EXTENSIONS.has(extension)) {
    return undefined;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) {
    return undefined;
  }
  const sourceMtimeMs = Math.trunc(stat.mtimeMs);
  const sourceSizeBytes = stat.size;
  const cachedSummary = readCachedProjectDocumentSummary({
    document,
    uri: filePath,
    sourceMtimeMs,
    sourceSizeBytes,
  });
  if (cachedSummary) {
    return cachedSummary;
  }

  const content = readProjectDocumentText({ filePath, extension, stat });
  if (!content) {
    return undefined;
  }

  const normalizedContent = normalizeDocumentText(content.text);
  if (normalizedContent.length < SUMMARY_MIN_CHARS && !content.truncated) {
    deleteCachedProjectDocumentSummary(document);
    return undefined;
  }

  const headings = extractMarkdownHeadings(normalizedContent);
  const excerpt = firstUsefulExcerpt(normalizedContent);
  const parts = [
    `Resumen automatico local (${formatSummarySource(content.source)}; ${formatBytes(stat.size)}; contenido no confiable):`,
    headings.length > 0 ? `Encabezados: ${headings.join(" | ")}` : undefined,
    excerpt ? `Extracto: ${excerpt}` : undefined,
    content.truncated
      ? `Nota: solo se proceso texto hasta ${formatBytes(SUMMARY_READ_BYTES)}.`
      : undefined,
  ].filter((part): part is string => Boolean(part));

  const summary = truncateSummary(parts.join("\n  "));
  writeCachedProjectDocumentSummary({
    document,
    uri: filePath,
    sourceMtimeMs,
    sourceSizeBytes,
    summary,
  });
  return summary;
}

export function diagnoseProjectDocumentSummary(
  document: ProjectDocumentRecord,
): ProjectDocumentSummaryDiagnostic {
  const uriKind = classifyDocumentUri(document.uri);
  if (uriKind === "none") {
    return {
      status: "unsupported",
      label: "No path",
      reason: "No URI or local path is configured for this document.",
      uriKind,
      cache: "not_applicable",
      injectsSummary: false,
    };
  }
  if (uriKind === "remote") {
    return {
      status: "remote",
      label: "Remote reference",
      reason: "Remote URLs are kept as references and are not read for local summaries yet.",
      uriKind,
      cache: "not_applicable",
      injectsSummary: false,
    };
  }
  if (uriKind === "obsidian") {
    return {
      status: "unsupported",
      label: "Obsidian link",
      reason: "Obsidian deep links are kept as references; use a local vault path to summarize.",
      uriKind,
      cache: "not_applicable",
      injectsSummary: false,
    };
  }

  const filePath = resolveLocalDocumentPath(document.uri);
  if (!filePath) {
    return {
      status: "unsupported",
      label: "Unsupported URI",
      reason: "Only absolute local paths and file:// URLs can be inspected locally.",
      uriKind,
      cache: "not_applicable",
      injectsSummary: false,
    };
  }

  const extension = path.extname(filePath).toLowerCase();
  if (!SUMMARY_EXTRACTABLE_EXTENSIONS.has(extension)) {
    return {
      status: "unsupported",
      label: "Unsupported type",
      reason: "This file type is not summarized automatically.",
      uriKind,
      cache: "not_applicable",
      injectsSummary: false,
      filePath,
      ...(extension ? { extension } : {}),
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return {
      status: "missing",
      label: "Not found",
      reason: "The local file cannot be found from this OpenClaw process.",
      uriKind,
      cache: "missing",
      injectsSummary: false,
      filePath,
      ...(extension ? { extension } : {}),
    };
  }

  if (!stat.isFile()) {
    return {
      status: "unreadable",
      label: "Not a file",
      reason: "The configured path exists but is not a regular file.",
      uriKind,
      cache: "not_applicable",
      injectsSummary: false,
      filePath,
      ...(extension ? { extension } : {}),
    };
  }

  const sourceMtimeMs = Math.trunc(stat.mtimeMs);
  const sourceSizeBytes = stat.size;
  const isTextDocument = SUMMARY_TEXT_EXTENSIONS.has(extension);
  if (!isTextDocument && sourceSizeBytes > SUMMARY_BINARY_MAX_BYTES) {
    return {
      status: "unsupported",
      label: "Too large",
      reason: `PDF/DOCX extraction is limited to ${formatBytes(SUMMARY_BINARY_MAX_BYTES)} per file.`,
      uriKind,
      cache: "not_applicable",
      injectsSummary: false,
      filePath,
      extension,
      sizeBytes: sourceSizeBytes,
      mtimeMs: sourceMtimeMs,
    };
  }

  const cachedRow = readCachedProjectDocumentSummaryRow(document);
  const currentCache =
    cachedRow?.uri === filePath &&
    cachedRow.sourceMtimeMs === sourceMtimeMs &&
    cachedRow.sourceSizeBytes === sourceSizeBytes;

  if (isTextDocument && sourceSizeBytes < SUMMARY_MIN_CHARS) {
    return {
      status: "not_needed",
      label: "Small file",
      reason: `Below the automatic summary threshold (${formatBytes(sourceSizeBytes)}).`,
      uriKind,
      cache: currentCache ? "hit" : cachedRow ? "stale" : "not_applicable",
      injectsSummary: false,
      filePath,
      extension,
      sizeBytes: sourceSizeBytes,
      mtimeMs: sourceMtimeMs,
    };
  }

  if (currentCache) {
    return {
      status: "summarized",
      label: "Cached summary",
      reason: "A current automatic summary is cached and will be injected with project context.",
      uriKind,
      cache: "hit",
      injectsSummary: true,
      filePath,
      extension,
      sizeBytes: sourceSizeBytes,
      mtimeMs: sourceMtimeMs,
    };
  }

  return {
    status: "eligible",
    label: cachedRow ? "Needs refresh" : "Will summarize",
    reason: cachedRow
      ? "The cached summary is stale and will refresh on the next prompt."
      : isTextDocument
        ? "The file is eligible for automatic summary on the next prompt."
        : "The file is eligible for local text extraction and summary on the next prompt.",
    uriKind,
    cache: cachedRow ? "stale" : "missing",
    injectsSummary: true,
    filePath,
    extension,
    sizeBytes: sourceSizeBytes,
    mtimeMs: sourceMtimeMs,
  };
}

function readProjectDocumentText(params: {
  filePath: string;
  extension: string;
  stat: fs.Stats;
}): ProjectDocumentText | undefined {
  if (SUMMARY_TEXT_EXTENSIONS.has(params.extension)) {
    return readPlainProjectDocumentText(params.filePath, params.stat);
  }
  if (params.stat.size > SUMMARY_BINARY_MAX_BYTES) {
    return undefined;
  }
  if (params.extension === ".pdf") {
    return extractPdfText(params.filePath);
  }
  if (params.extension === ".docx") {
    return extractDocxText(params.filePath);
  }
  return undefined;
}

function readPlainProjectDocumentText(
  filePath: string,
  stat: fs.Stats,
): ProjectDocumentText | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const bytesToRead = Math.min(stat.size, SUMMARY_READ_BYTES);
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
      return {
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        source: "text",
        truncated: stat.size > SUMMARY_READ_BYTES,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function extractPdfText(filePath: string): ProjectDocumentText | undefined {
  const cliPath = resolveClawPdfCliPath();
  if (!cliPath) {
    return undefined;
  }
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "extract",
      "--plain",
      "--quiet",
      "--no-input",
      "--mode",
      "text",
      "--max-pages",
      String(SUMMARY_PDF_MAX_PAGES),
      "--max-text-chars",
      String(SUMMARY_READ_BYTES),
      filePath,
    ],
    {
      encoding: "utf8",
      maxBuffer: SUMMARY_READ_BYTES * 4,
      timeout: SUMMARY_EXTRACT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  return {
    text: result.stdout,
    source: "pdf",
    truncated: result.stdout.length >= SUMMARY_READ_BYTES,
  };
}

function resolveClawPdfCliPath(): string | undefined {
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.resolve("clawpdf"))), "cli.js");
  } catch {
    return undefined;
  }
}

function extractDocxText(filePath: string): ProjectDocumentText | undefined {
  const script = `
    import fs from "node:fs/promises";
    import JSZip from "jszip";
    const filePath = process.argv[1];
    const maxChars = Number(process.argv[2]);
    const buffer = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files)
      .filter((name) => /^word\\/(document|footnotes|endnotes|header\\d+|footer\\d+)\\.xml$/u.test(name))
      .sort((left, right) => left === "word/document.xml" ? -1 : right === "word/document.xml" ? 1 : left.localeCompare(right));
    const parts = [];
    for (const name of names) {
      const entry = zip.file(name);
      if (!entry) continue;
      const xml = await entry.async("text");
      parts.push(extractText(xml));
      if (parts.join("\\n").length >= maxChars) break;
    }
    process.stdout.write(parts.join("\\n").slice(0, maxChars));
    function extractText(xml) {
      return decodeEntities(xml
        .replace(/<w:(tab|br)[^>]*\\/>/gu, " ")
        .replace(/<\\/w:p>/gu, "\\n")
        .replace(/<[^>]+>/gu, "")
        .replace(/[ \\t]+/gu, " ")
        .replace(/\\n{3,}/gu, "\\n\\n")
        .trim());
    }
    function decodeEntities(value) {
      return value
        .replace(/&lt;/gu, "<")
        .replace(/&gt;/gu, ">")
        .replace(/&quot;/gu, '"')
        .replace(/&apos;/gu, "'")
        .replace(/&amp;/gu, "&");
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, filePath, String(SUMMARY_READ_BYTES)],
    {
      encoding: "utf8",
      maxBuffer: SUMMARY_READ_BYTES * 4,
      timeout: SUMMARY_EXTRACT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  return {
    text: result.stdout,
    source: "docx",
    truncated: result.stdout.length >= SUMMARY_READ_BYTES,
  };
}

type CachedProjectDocumentSummaryRow = {
  uri: string;
  sourceMtimeMs: number;
  sourceSizeBytes: number;
  summary: string;
  updatedAtMs: number;
};

function readCachedProjectDocumentSummaryRow(
  document: ProjectDocumentRecord,
): CachedProjectDocumentSummaryRow | undefined {
  try {
    const database = openOpenClawStateDatabase();
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getProjectDocumentSummaryCacheKysely(database.db)
        .selectFrom("project_document_summary_cache")
        .select(["uri", "source_mtime_ms", "source_size_bytes", "summary", "updated_at_ms"])
        .where("project_id", "=", document.projectId)
        .where("document_id", "=", document.documentId),
    );
    if (
      !row ||
      typeof row.uri !== "string" ||
      typeof row.source_mtime_ms !== "number" ||
      typeof row.source_size_bytes !== "number" ||
      typeof row.summary !== "string" ||
      typeof row.updated_at_ms !== "number"
    ) {
      return undefined;
    }
    return {
      uri: row.uri,
      sourceMtimeMs: row.source_mtime_ms,
      sourceSizeBytes: row.source_size_bytes,
      summary: row.summary,
      updatedAtMs: row.updated_at_ms,
    };
  } catch {
    return undefined;
  }
}

function readCachedProjectDocumentSummary(params: {
  document: ProjectDocumentRecord;
  uri: string;
  sourceMtimeMs: number;
  sourceSizeBytes: number;
}): string | undefined {
  try {
    const database = openOpenClawStateDatabase();
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getProjectDocumentSummaryCacheKysely(database.db)
        .selectFrom("project_document_summary_cache")
        .select("summary")
        .where("project_id", "=", params.document.projectId)
        .where("document_id", "=", params.document.documentId)
        .where("uri", "=", params.uri)
        .where("source_mtime_ms", "=", params.sourceMtimeMs)
        .where("source_size_bytes", "=", params.sourceSizeBytes),
    );
    return typeof row?.summary === "string" && row.summary ? row.summary : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedProjectDocumentSummary(params: {
  document: ProjectDocumentRecord;
  uri: string;
  sourceMtimeMs: number;
  sourceSizeBytes: number;
  summary: string;
}): void {
  try {
    const now = Date.now();
    runOpenClawStateWriteTransaction((database) => {
      const row = {
        project_id: params.document.projectId,
        document_id: params.document.documentId,
        uri: params.uri,
        source_mtime_ms: params.sourceMtimeMs,
        source_size_bytes: params.sourceSizeBytes,
        summary: params.summary,
        created_at_ms: now,
        updated_at_ms: now,
      };
      executeSqliteQuerySync(
        database.db,
        getProjectDocumentSummaryCacheKysely(database.db)
          .insertInto("project_document_summary_cache")
          .values(row)
          .onConflict((conflict) =>
            conflict.columns(["project_id", "document_id"]).doUpdateSet({
              uri: row.uri,
              source_mtime_ms: row.source_mtime_ms,
              source_size_bytes: row.source_size_bytes,
              summary: row.summary,
              updated_at_ms: row.updated_at_ms,
            }),
          ),
      );
    });
  } catch {
    // Cache failures must never block prompt construction.
  }
}

function deleteCachedProjectDocumentSummary(document: ProjectDocumentRecord): void {
  try {
    runOpenClawStateWriteTransaction((database) => {
      executeSqliteQuerySync(
        database.db,
        getProjectDocumentSummaryCacheKysely(database.db)
          .deleteFrom("project_document_summary_cache")
          .where("project_id", "=", document.projectId)
          .where("document_id", "=", document.documentId),
      );
    });
  } catch {
    // Cache failures must never block prompt construction.
  }
}

function resolveLocalDocumentPath(uri: string | undefined): string | undefined {
  const value = uri?.trim();
  if (!value || value.startsWith("http://") || value.startsWith("https://")) {
    return undefined;
  }
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("obsidian://")) {
    return undefined;
  }
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : undefined;
}

function classifyDocumentUri(uri: string | undefined): ProjectDocumentSummaryUriKind {
  const value = uri?.trim();
  if (!value) {
    return "none";
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return "remote";
  }
  if (value.startsWith("file://")) {
    return "file";
  }
  if (value.startsWith("obsidian://")) {
    return "obsidian";
  }
  return "local";
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function normalizeDocumentText(value: string): string {
  return value
    .replace(/\u0000/gu, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function extractMarkdownHeadings(value: string): string[] {
  const headings: string[] = [];
  for (const line of value.split("\n")) {
    const match = /^(#{1,3})\s+(.+)$/u.exec(line);
    const heading = match?.[2]?.replace(/#+$/u, "").trim();
    if (heading) {
      headings.push(heading);
    }
    if (headings.length >= 8) {
      break;
    }
  }
  return headings;
}

function firstUsefulExcerpt(value: string): string | undefined {
  const lines = value
    .split("\n")
    .filter((line) => {
      if (!line) {
        return false;
      }
      return !/^#{1,6}\s+/u.test(line);
    })
    .slice(0, 80);
  const excerpt = lines.join(" ").replace(/\s+/gu, " ").trim();
  return excerpt ? truncateSummary(excerpt) : undefined;
}

function truncateSummary(value: string): string {
  if (value.length <= SUMMARY_MAX_CHARS) {
    return value;
  }
  return `${value.slice(0, SUMMARY_MAX_CHARS - 20).trimEnd()}...`;
}

function formatSummarySource(value: ProjectDocumentText["source"]): string {
  if (value === "pdf") {
    return "PDF extraido";
  }
  if (value === "docx") {
    return "DOCX extraido";
  }
  return "texto local";
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
