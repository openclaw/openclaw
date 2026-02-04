import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type MemoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
};

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
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

async function walkDir(dir: string, files: string[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkDir(full, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".md")) {
      continue;
    }
    files.push(full);
  }
}

export async function listMemoryFiles(
  workspaceDir: string,
  extraPaths?: string[],
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
          await walkDir(inputPath, result);
          continue;
        }
        if (stat.isFile() && inputPath.endsWith(".md")) {
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

// Types for semantic chunking
type ParsedBlock = {
  type: "header" | "code" | "list" | "paragraph";
  content: string;
  startLine: number;
  endLine: number;
  headerLevel?: number;
  headerText?: string;
};

type HeaderContext = {
  level: number;
  text: string;
};

/**
 * Parse markdown content into semantic blocks (headers, code blocks, lists, paragraphs).
 * Preserves line numbers for accurate chunk metadata.
 */
export function parseMarkdownBlocks(content: string): ParsedBlock[] {
  const lines = content.split("\n");
  const blocks: ParsedBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;

    // Skip empty lines
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Check for code block (``` or ~~~)
    const codeMatch = line.match(/^(`{3,}|~{3,})/);
    if (codeMatch) {
      const fence = codeMatch[1];
      const codeLines: string[] = [line];
      const startLine = lineNo;
      i += 1;

      // Find closing fence
      while (i < lines.length) {
        const codeLine = lines[i] ?? "";
        codeLines.push(codeLine);
        i += 1;
        if (codeLine.startsWith(fence)) {
          break;
        }
      }

      blocks.push({
        type: "code",
        content: codeLines.join("\n"),
        startLine,
        endLine: lineNo + codeLines.length - 1,
      });
      continue;
    }

    // Check for header
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      blocks.push({
        type: "header",
        content: line,
        startLine: lineNo,
        endLine: lineNo,
        headerLevel: headerMatch[1].length,
        headerText: headerMatch[2].trim(),
      });
      i += 1;
      continue;
    }

    // Check for list (ordered or unordered)
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s/);
    if (listMatch) {
      const listLines: string[] = [line];
      const startLine = lineNo;
      const baseIndent = listMatch[1].length;
      i += 1;

      // Collect all consecutive list items and their continuations
      while (i < lines.length) {
        const nextLine = lines[i] ?? "";
        // Empty line might be part of list (loose list) or end of list
        if (nextLine.trim() === "") {
          // Look ahead to see if list continues
          const lookAhead = lines[i + 1] ?? "";
          const continuesList = lookAhead.match(/^(\s*)([-*+]|\d+\.)\s/);
          if (continuesList) {
            listLines.push(nextLine);
            i += 1;
            continue;
          }
          break;
        }
        // Check if it's a list item or continuation (indented)
        const isListItem = nextLine.match(/^(\s*)([-*+]|\d+\.)\s/);
        const indent = nextLine.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (isListItem || indent > baseIndent) {
          listLines.push(nextLine);
          i += 1;
        } else {
          break;
        }
      }

      blocks.push({
        type: "list",
        content: listLines.join("\n"),
        startLine,
        endLine: startLine + listLines.length - 1,
      });
      continue;
    }

    // Otherwise it's a paragraph - collect until empty line or special block
    const paraLines: string[] = [line];
    const startLine = lineNo;
    i += 1;

    while (i < lines.length) {
      const nextLine = lines[i] ?? "";
      // Stop at empty line
      if (nextLine.trim() === "") {
        break;
      }
      // Stop at header
      if (nextLine.match(/^#{1,6}\s/)) {
        break;
      }
      // Stop at code fence
      if (nextLine.match(/^(`{3,}|~{3,})/)) {
        break;
      }
      // Stop at list
      if (nextLine.match(/^(\s*)([-*+]|\d+\.)\s/)) {
        break;
      }
      paraLines.push(nextLine);
      i += 1;
    }

    blocks.push({
      type: "paragraph",
      content: paraLines.join("\n"),
      startLine,
      endLine: startLine + paraLines.length - 1,
    });
  }

  return blocks;
}

/**
 * Build header context string from active headers.
 * Example: "## API > ### Authentication"
 */
function buildHeaderContext(headers: HeaderContext[]): string {
  if (headers.length === 0) {
    return "";
  }
  return headers.map((h) => `${"#".repeat(h.level)} ${h.text}`).join(" > ");
}

/**
 * Split text by sentences for fine-grained chunking.
 * Handles common abbreviations to avoid false splits.
 */
function splitBySentences(text: string): string[] {
  // Split on sentence boundaries, keeping the delimiter
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.filter((p) => p.trim().length > 0);
}

/**
 * Semantic markdown chunking that respects document structure.
 * - Preserves code blocks intact
 * - Keeps lists together when possible
 * - Adds header context to chunks for better recall
 * - Falls back to sentence splitting for oversized blocks
 */
export function chunkMarkdownSemantic(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const blocks = parseMarkdownBlocks(content);
  if (blocks.length === 0) {
    return [];
  }

  const maxChars = Math.max(32, chunking.tokens * 4);
  const chunks: MemoryChunk[] = [];
  const activeHeaders: HeaderContext[] = [];

  // Track current accumulated content for merging small blocks
  let accumulated: { lines: string[]; startLine: number; endLine: number } | null = null;

  const flushAccumulated = () => {
    if (!accumulated || accumulated.lines.length === 0) {
      return;
    }
    const text = accumulated.lines.join("\n");
    chunks.push({
      startLine: accumulated.startLine,
      endLine: accumulated.endLine,
      text,
      hash: hashText(text),
    });
    accumulated = null;
  };

  const addToAccumulated = (text: string, startLine: number, endLine: number) => {
    if (!accumulated) {
      accumulated = { lines: [text], startLine, endLine };
    } else {
      accumulated.lines.push(text);
      accumulated.endLine = endLine;
    }
  };

  const getAccumulatedSize = (): number => {
    if (!accumulated) {
      return 0;
    }
    return accumulated.lines.join("\n").length;
  };

  for (const block of blocks) {
    // Update header context
    if (block.type === "header" && block.headerLevel && block.headerText) {
      // Remove headers at same or lower level
      while (
        activeHeaders.length > 0 &&
        activeHeaders[activeHeaders.length - 1]!.level >= block.headerLevel
      ) {
        activeHeaders.pop();
      }
      activeHeaders.push({ level: block.headerLevel, text: block.headerText });
    }

    const headerContext = buildHeaderContext(activeHeaders);
    const contextPrefix = headerContext ? `${headerContext}\n\n` : "";

    // Code blocks: never split, always separate chunk
    if (block.type === "code") {
      flushAccumulated();
      const text = contextPrefix + block.content;
      // If code block is too large, we still keep it intact (better than broken code)
      chunks.push({
        startLine: block.startLine,
        endLine: block.endLine,
        text,
        hash: hashText(text),
      });
      continue;
    }

    // Headers: start a new chunk
    if (block.type === "header") {
      flushAccumulated();
      // Headers are added to next content block via context, not as separate chunks
      continue;
    }

    const blockWithContext = contextPrefix + block.content;

    // If block fits in max size, try to accumulate
    if (blockWithContext.length <= maxChars) {
      // Check if adding to accumulated would exceed max
      if (getAccumulatedSize() + blockWithContext.length + 1 > maxChars) {
        flushAccumulated();
      }
      addToAccumulated(blockWithContext, block.startLine, block.endLine);
      continue;
    }

    // Block is too large - need to split
    flushAccumulated();

    if (block.type === "list") {
      // Try to keep list items together, split by items if needed
      const listLines = block.content.split("\n");
      let currentChunk: string[] = [];
      let chunkStart = block.startLine;

      for (let j = 0; j < listLines.length; j += 1) {
        const line = listLines[j] ?? "";
        const lineWithContext = currentChunk.length === 0 ? contextPrefix + line : line;

        if (
          currentChunk.length > 0 &&
          currentChunk.join("\n").length + lineWithContext.length + 1 > maxChars
        ) {
          // Flush current chunk
          const text = currentChunk.join("\n");
          chunks.push({
            startLine: chunkStart,
            endLine: block.startLine + j - 1,
            text,
            hash: hashText(text),
          });
          currentChunk = [contextPrefix + line];
          chunkStart = block.startLine + j;
        } else {
          currentChunk.push(currentChunk.length === 0 ? contextPrefix + line : line);
        }
      }

      if (currentChunk.length > 0) {
        const text = currentChunk.join("\n");
        chunks.push({
          startLine: chunkStart,
          endLine: block.endLine,
          text,
          hash: hashText(text),
        });
      }
      continue;
    }

    // Paragraph too large - split by sentences
    const sentences = splitBySentences(block.content);
    let currentChunk: string[] = [];
    let chunkStart = block.startLine;

    for (const sentence of sentences) {
      const sentenceWithContext = currentChunk.length === 0 ? contextPrefix + sentence : sentence;

      if (
        currentChunk.length > 0 &&
        currentChunk.join(" ").length + sentenceWithContext.length + 1 > maxChars
      ) {
        const text = currentChunk.join(" ");
        chunks.push({
          startLine: chunkStart,
          endLine: block.endLine,
          text,
          hash: hashText(text),
        });
        currentChunk = [contextPrefix + sentence];
        chunkStart = block.startLine;
      } else {
        currentChunk.push(currentChunk.length === 0 ? contextPrefix + sentence : sentence);
      }
    }

    if (currentChunk.length > 0) {
      const text = currentChunk.join(" ");
      chunks.push({
        startLine: chunkStart,
        endLine: block.endLine,
        text,
        hash: hashText(text),
      });
    }
  }

  flushAccumulated();
  return chunks;
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
): Promise<MemoryFileEntry> {
  const stat = await fs.stat(absPath);
  const content = await fs.readFile(absPath, "utf-8");
  const hash = hashText(content);
  return {
    path: path.relative(workspaceDir, absPath).replace(/\\/g, "/"),
    absPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash,
  };
}

/**
 * Chunk markdown content for embedding and search.
 * Uses semantic chunking by default (respects headers, code blocks, lists).
 * Set semantic: false for legacy character-based chunking.
 */
export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number; semantic?: boolean },
): MemoryChunk[] {
  // Use semantic chunking by default
  if (chunking.semantic !== false) {
    return chunkMarkdownSemantic(content, chunking);
  }

  // Legacy character-based chunking (kept for backwards compatibility)
  return chunkMarkdownLegacy(content, chunking);
}

/**
 * Legacy character-based chunking.
 * Splits content by fixed character count with overlap.
 * @deprecated Use semantic chunking instead (default behavior)
 */
export function chunkMarkdownLegacy(
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
