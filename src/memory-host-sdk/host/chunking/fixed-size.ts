import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../../utils/cjk-chars.js";
import { buildTextEmbeddingInput } from "../embedding-inputs.js";
import type { MemoryChunk } from "../internal.js";
import { hashText } from "./hash.js";
import type { ChunkingStrategy, ChunkingConfig } from "./types.js";

/** Default chunk size in tokens. */
export const DEFAULT_CHUNK_TOKENS = 400;

/** Default token overlap between adjacent chunks. */
export const DEFAULT_CHUNK_OVERLAP = 80;

/**
 * Fixed-size chunking strategy.
 *
 * Splits content by accumulating lines until the token budget is reached,
 * then flushes the chunk and carries overlap lines into the next chunk.
 * This is the original `chunkMarkdown` algorithm extracted into a strategy class.
 */
export class FixedSizeStrategy implements ChunkingStrategy {
  readonly name = "fixed-size" as const;
  private readonly config: ChunkingConfig;
  private readonly tokens: number;
  private readonly overlap: number;

  constructor(config: ChunkingConfig) {
    this.config = config;
    this.tokens = config.tokens ?? DEFAULT_CHUNK_TOKENS;
    this.overlap = config.overlap ?? DEFAULT_CHUNK_OVERLAP;
  }

  chunk(content: string, cfg: ChunkingConfig): MemoryChunk[] {
    return chunkFixedSize(content, { tokens: this.tokens, overlap: this.overlap });
  }
}

/**
 * Core fixed-size chunking implementation.
 * Extracted from the original `chunkMarkdown` in `internal.ts`.
 */
export function chunkFixedSize(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) {
    return [];
  }
  const maxChars = Math.max(32, chunking.tokens * CHARS_PER_TOKEN_ESTIMATE);
  const overlapChars = Math.max(0, chunking.overlap * CHARS_PER_TOKEN_ESTIMATE);
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
      acc += estimateStringChars(entry.line) + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) {
        break;
      }
    }
    current = kept;
    currentChars = kept.reduce((sum, entry) => sum + estimateStringChars(entry.line) + 1, 0);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      // First pass: slice at maxChars (preserves original behaviour for Latin).
      // Second pass: if a segment's *weighted* size still exceeds the budget
      // (happens for CJK-heavy text where 1 char ≈ 1 token), re-split it at
      // chunking.tokens so the chunk stays within the token budget.
      for (let start = 0; start < line.length; start += maxChars) {
        const coarse = line.slice(start, start + maxChars);
        if (estimateStringChars(coarse) > maxChars) {
          const fineStep = Math.max(1, chunking.tokens);
          for (let j = 0; j < coarse.length; ) {
            let end = Math.min(j + fineStep, coarse.length);
            // Avoid splitting inside a UTF-16 surrogate pair (CJK Extension B+).
            if (end < coarse.length) {
              const code = coarse.charCodeAt(end - 1);
              if (code >= 0xd800 && code <= 0xdbff) {
                end += 1; // include the low surrogate
              }
            }
            segments.push(coarse.slice(j, end));
            j = end; // advance cursor to the adjusted boundary
          }
        } else {
          segments.push(coarse);
        }
      }
    }
    for (const segment of segments) {
      const lineSize = estimateStringChars(segment) + 1;
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
