import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { detectMime } from "../media/mime.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { estimateStructuredEmbeddingInputBytes } from "./embedding-input-limits.js";
import { buildTextEmbeddingInput, type EmbeddingInput } from "./embedding-inputs.js";
import { isFileMissingError } from "./fs-utils.js";
import {
  buildMemoryMultimodalLabel,
  classifyMemoryMultimodalPath,
  type MemoryMultimodalModality,
  type MemoryMultimodalSettings,
} from "./multimodal.js";

/** Languages with first-class declaration-boundary chunking support. */
export type CodeLanguage = "typescript" | "python" | "go" | "rust" | "generic";

/**
 * File extensions recognised as indexable code files.
 * Maps lowercase extension (including leading dot) → CodeLanguage.
 */
export const CODE_EXTENSIONS: Readonly<Record<string, CodeLanguage>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "generic",
  ".java": "generic",
  ".kt": "generic",
  ".cs": "generic",
  ".swift": "generic",
  ".cpp": "generic",
  ".c": "generic",
  ".h": "generic",
  ".hpp": "generic",
};

/**
 * Return the CodeLanguage for a file path, or null if the extension is not a
 * recognised code extension.
 */
export function detectCodeLanguage(filePath: string): CodeLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS[ext] ?? null;
}

export type MemoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  dataHash?: string;
  kind?: "markdown" | "multimodal" | "code";
  lang?: CodeLanguage;
  contentText?: string;
  modality?: MemoryMultimodalModality;
  mimeType?: string;
};

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embeddingInput?: EmbeddingInput;
};

export type MultimodalMemoryChunk = {
  chunk: MemoryChunk;
  structuredInputBytes: number;
};

const DISABLED_MULTIMODAL_SETTINGS: MemoryMultimodalSettings = {
  enabled: false,
  modalities: [],
  maxFileBytes: 0,
};

export function ensureDir(dir: string): string {
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

export function normalizeRelPath(value: string): string {
  const trimmed = value.trim().replace(/^[./]+/, "");
  return trimmed.replace(/\\/g, "/");
}

export function normalizeExtraMemoryPaths(workspaceDir: string, extraPaths?: string[]): string[] {
  if (!extraPaths?.length) {
    return [];
  }
  const resolved = extraPaths
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) =>
      path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value),
    );
  return Array.from(new Set(resolved));
}

export function isMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  if (normalized === "MEMORY.md" || normalized === "memory.md") {
    return true;
  }
  return normalized.startsWith("memory/");
}

function isAllowedMemoryFilePath(filePath: string, multimodal?: MemoryMultimodalSettings): boolean {
  if (filePath.endsWith(".md")) {
    return true;
  }
  if (detectCodeLanguage(filePath) !== null) {
    return true;
  }
  return (
    classifyMemoryMultimodalPath(filePath, multimodal ?? DISABLED_MULTIMODAL_SETTINGS) !== null
  );
}

async function walkDir(dir: string, files: string[], multimodal?: MemoryMultimodalSettings) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkDir(full, files, multimodal);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!isAllowedMemoryFilePath(full, multimodal)) {
      continue;
    }
    files.push(full);
  }
}

export async function listMemoryFiles(
  workspaceDir: string,
  extraPaths?: string[],
  multimodal?: MemoryMultimodalSettings,
): Promise<string[]> {
  const result: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const addMarkdownFile = async (absPath: string) => {
    try {
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return;
      }
      if (!absPath.endsWith(".md")) {
        return;
      }
      result.push(absPath);
    } catch {}
  };

  await addMarkdownFile(memoryFile);
  await addMarkdownFile(altMemoryFile);
  try {
    const dirStat = await fs.lstat(memoryDir);
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      await walkDir(memoryDir, result);
    }
  } catch {}

  const normalizedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  if (normalizedExtraPaths.length > 0) {
    for (const inputPath of normalizedExtraPaths) {
      try {
        const stat = await fs.lstat(inputPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          await walkDir(inputPath, result, multimodal);
          continue;
        }
        if (stat.isFile() && isAllowedMemoryFilePath(inputPath, multimodal)) {
          result.push(inputPath);
        }
      } catch {}
    }
  }
  if (result.length <= 1) {
    return result;
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of result) {
    let key = entry;
    try {
      key = await fs.realpath(entry);
    } catch {}
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
  multimodal?: MemoryMultimodalSettings,
): Promise<MemoryFileEntry | null> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if (isFileMissingError(err)) {
      return null;
    }
    throw err;
  }
  const normalizedPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
  const multimodalSettings = multimodal ?? DISABLED_MULTIMODAL_SETTINGS;
  const modality = classifyMemoryMultimodalPath(absPath, multimodalSettings);
  if (modality) {
    if (stat.size > multimodalSettings.maxFileBytes) {
      return null;
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(absPath);
    } catch (err) {
      if (isFileMissingError(err)) {
        return null;
      }
      throw err;
    }
    const mimeType = await detectMime({ buffer: buffer.subarray(0, 512), filePath: absPath });
    if (!mimeType || !mimeType.startsWith(`${modality}/`)) {
      return null;
    }
    const contentText = buildMemoryMultimodalLabel(modality, normalizedPath);
    const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const chunkHash = hashText(
      JSON.stringify({
        path: normalizedPath,
        contentText,
        mimeType,
        dataHash,
      }),
    );
    return {
      path: normalizedPath,
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: chunkHash,
      dataHash,
      kind: "multimodal",
      contentText,
      modality,
      mimeType,
    };
  }
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch (err) {
    if (isFileMissingError(err)) {
      return null;
    }
    throw err;
  }
  const hash = hashText(content);
  const codeLang = detectCodeLanguage(absPath);
  if (codeLang !== null) {
    return {
      path: normalizedPath,
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash,
      kind: "code",
      lang: codeLang,
    };
  }
  return {
    path: normalizedPath,
    absPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash,
    kind: "markdown",
  };
}

async function loadMultimodalEmbeddingInput(
  entry: Pick<
    MemoryFileEntry,
    "absPath" | "contentText" | "mimeType" | "kind" | "size" | "dataHash"
  >,
): Promise<EmbeddingInput | null> {
  if (entry.kind !== "multimodal" || !entry.contentText || !entry.mimeType) {
    return null;
  }
  let stat;
  try {
    stat = await fs.stat(entry.absPath);
  } catch (err) {
    if (isFileMissingError(err)) {
      return null;
    }
    throw err;
  }
  if (stat.size !== entry.size) {
    return null;
  }
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(entry.absPath);
  } catch (err) {
    if (isFileMissingError(err)) {
      return null;
    }
    throw err;
  }
  const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (entry.dataHash && entry.dataHash !== dataHash) {
    return null;
  }
  return {
    text: entry.contentText,
    parts: [
      { type: "text", text: entry.contentText },
      {
        type: "inline-data",
        mimeType: entry.mimeType,
        data: buffer.toString("base64"),
      },
    ],
  };
}

export async function buildMultimodalChunkForIndexing(
  entry: Pick<
    MemoryFileEntry,
    "absPath" | "contentText" | "mimeType" | "kind" | "hash" | "size" | "dataHash"
  >,
): Promise<MultimodalMemoryChunk | null> {
  const embeddingInput = await loadMultimodalEmbeddingInput(entry);
  if (!embeddingInput) {
    return null;
  }
  return {
    chunk: {
      startLine: 1,
      endLine: 1,
      text: entry.contentText ?? embeddingInput.text,
      hash: entry.hash,
      embeddingInput,
    },
    structuredInputBytes: estimateStructuredEmbeddingInputBytes(embeddingInput),
  };
}

export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) {
    return [];
  }
  const maxChars = Math.max(32, chunking.tokens * 4);
  const overlapChars = Math.max(0, chunking.overlap * 4);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const firstEntry = current[0];
    const lastEntry = current[current.length - 1];
    if (!firstEntry || !lastEntry) {
      return;
    }
    const text = current.map((entry) => entry.line).join("\n");
    const startLine = firstEntry.lineNo;
    const endLine = lastEntry.lineNo;
    chunks.push({
      startLine,
      endLine,
      text,
      hash: hashText(text),
      embeddingInput: buildTextEmbeddingInput(text),
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      if (!entry) {
        continue;
      }
      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) {
        break;
      }
    }
    current = kept;
    currentChars = kept.reduce((sum, entry) => sum + entry.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }
    for (const segment of segments) {
      const lineSize = segment.length + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }
  flush();
  return chunks;
}

/**
 * Patterns that match the opening line of a top-level declaration at
 * indentation level 0 (no leading whitespace).
 */
const DECL_START_RE: Record<CodeLanguage, RegExp> = {
  // Only match structural declarations. Bare re-exports (`export * from`,
  // `export { a, b }`) are intentionally excluded to avoid fragmenting barrel
  // files into dozens of single-line chunks.
  typescript:
    /^(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|abstract|declare)\b|export\s+default\s|async\s+(?:function|class)\b|function\s+\w|class\s+\w|const\s+\w[\w$]*\s*[=:]\s*(?:async\s+)?(?:function|\(|<)|interface\s+\w|type\s+\w[\w$]*\s*=|enum\s+\w|declare\s+|abstract\s+class\b)/,
  python: /^(?:async\s+)?(?:def|class)\s+\w|^@\w/,
  go: /^func\s|^type\s+\w+\s+(?:struct|interface)\b/,
  rust: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|impl|trait|type|const|static|mod)\s+\w/,
  generic: /^(?:function|class|def|fn|func|sub|procedure)\s+\w/,
};

/** Lines that are considered "leading context" and should be attached to the
 *  following declaration rather than standing alone. */
const LEADING_CONTEXT_RE = /^(?:\/\/|\/\*|\*|#[^!]|@\w|\[(?:derive|cfg|allow|test))/;

/**
 * Chunk source code using declaration-boundary heuristics (zero extra
 * dependencies — no tree-sitter or AST parser required).
 *
 * Algorithm:
 * 1. Scan lines at indentation level 0 for declaration starters.
 * 2. Walk backward from each starter to pull in preceding doc-comments,
 *    decorators, and blank lines as part of the same logical unit.
 * 3. Emit each unit as a chunk.  Oversized units are split further with
 *    chunkMarkdown() so the sliding-window size limit is always respected.
 * 4. Falls back to chunkMarkdown() when no declarations are detected.
 *
 * Use this in place of chunkMarkdown() for files recognised by
 * detectCodeLanguage() so that function/class boundaries become chunk
 * boundaries, improving retrieval precision.
 */
export function chunkCode(
  content: string,
  lang: CodeLanguage,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const lines = content.split("\n");
  if (content.trim().length === 0) {
    return [];
  }

  const maxChars = Math.max(32, chunking.tokens * 4);
  const re = DECL_START_RE[lang];

  // --- Phase 1: find declaration boundary lines ---
  // A "boundary" is the earliest line in a logical unit (declaration + any
  // leading comments/decorators immediately preceding it).
  const rawBoundaries: number[] = []; // 0-indexed
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.length > 0 && /^\s/.test(line)) {
      // Indented — skip (not a top-level declaration)
      continue;
    }
    if (re.test(line)) {
      // Walk backward to include preceding comments/decorators/blanks
      let start = i;
      while (start > 0) {
        const prev = lines[start - 1] ?? "";
        const trimmed = prev.trimStart();
        if (trimmed === "" || LEADING_CONTEXT_RE.test(trimmed)) {
          start -= 1;
        } else {
          break;
        }
      }
      // Only add if this doesn't overlap with the previous boundary
      if (rawBoundaries.length === 0 || start > (rawBoundaries[rawBoundaries.length - 1] ?? -1)) {
        rawBoundaries.push(start);
      }
    }
  }

  // Fall back to sliding-window when the file has no detectable declarations
  if (rawBoundaries.length === 0) {
    return chunkMarkdown(content, chunking);
  }

  // --- Phase 2: build [startLine, endLine] unit ranges (1-indexed) ---
  const unitRanges: Array<[number, number]> = [];

  // Lines before the first declaration boundary (imports, file-level preamble)
  const firstBoundary = rawBoundaries[0] ?? 0;
  if (firstBoundary > 0) {
    unitRanges.push([1, firstBoundary]); // 1-indexed; end is inclusive
  }

  for (let b = 0; b < rawBoundaries.length; b += 1) {
    const start = (rawBoundaries[b] ?? 0) + 1; // convert to 1-indexed
    const end =
      b + 1 < rawBoundaries.length
        ? (rawBoundaries[b + 1] ?? lines.length) // next boundary start (0-indexed) is end of this unit
        : lines.length;
    unitRanges.push([start, end]);
  }

  // --- Phase 3: emit chunks ---
  const result: MemoryChunk[] = [];

  for (const [unitStart, unitEnd] of unitRanges) {
    const unitLines = lines.slice(unitStart - 1, unitEnd);
    const unitText = unitLines.join("\n");
    if (unitText.trim().length === 0) {
      continue;
    }

    if (unitText.length <= maxChars) {
      result.push({
        startLine: unitStart,
        endLine: unitEnd,
        text: unitText,
        hash: hashText(unitText),
        embeddingInput: buildTextEmbeddingInput(unitText),
      });
    } else {
      // Unit exceeds size limit — apply sliding-window within it and remap
      // line numbers back to the source file coordinate space.
      const subChunks = chunkMarkdown(unitText, chunking);
      for (const sub of subChunks) {
        result.push({
          ...sub,
          startLine: unitStart + sub.startLine - 1,
          endLine: unitStart + sub.endLine - 1,
        });
      }
    }
  }

  return result;
}

/**
 * Remap chunk startLine/endLine from content-relative positions to original
 * source file positions using a lineMap.  Each entry in lineMap gives the
 * 1-indexed source line for the corresponding 0-indexed content line.
 *
 * This is used for session JSONL files where buildSessionEntry() flattens
 * messages into a plain-text string before chunking.  Without remapping the
 * stored line numbers would reference positions in the flattened text rather
 * than the original JSONL file.
 */
export function remapChunkLines(chunks: MemoryChunk[], lineMap: number[] | undefined): void {
  if (!lineMap || lineMap.length === 0) {
    return;
  }
  for (const chunk of chunks) {
    // startLine/endLine are 1-indexed; lineMap is 0-indexed by content line
    chunk.startLine = lineMap[chunk.startLine - 1] ?? chunk.startLine;
    chunk.endLine = lineMap[chunk.endLine - 1] ?? chunk.endLine;
  }
}

export function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const { results, firstError, hasError } = await runTasksWithConcurrency({
    tasks,
    limit,
    errorMode: "stop",
  });
  if (hasError) {
    throw firstError;
  }
  return results;
}
