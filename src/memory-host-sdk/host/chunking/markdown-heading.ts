import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../../utils/cjk-chars.js";
import { buildTextEmbeddingInput } from "../embedding-inputs.js";
import type { MemoryChunk } from "../internal.js";
import { hashText } from "./hash.js";
import { chunkFixedSize } from "./fixed-size.js";
import type { ChunkingStrategy, ChunkingConfig } from "./types.js";

/** Default maximum heading depth to split on. */
export const DEFAULT_MAX_DEPTH = 3;

/** Default max tokens per chunk (fallback for oversized sections). */
export const DEFAULT_MAX_TOKENS = 400;

const HEADING_RE = /^(#{1,6})\s/;

type Section = {
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
  lines: string[];
};

/**
 * Markdown-heading chunking strategy.
 *
 * Splits content at Markdown heading boundaries (up to `maxDepth` level).
 * Sections that exceed `maxTokens` are sub-chunked using the fixed-size strategy.
 */
export class MarkdownHeadingStrategy implements ChunkingStrategy {
  readonly name = "markdown-heading" as const;
  private readonly config: ChunkingConfig;
  private readonly maxDepth: number;
  private readonly maxTokens: number;

  constructor(config: ChunkingConfig) {
    this.config = config;
    this.maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  chunk(content: string, cfg: ChunkingConfig): MemoryChunk[] {
    const sections = this.splitIntoSections(content);
    const chunks: MemoryChunk[] = [];
    const maxChars = Math.max(32, this.maxTokens * CHARS_PER_TOKEN_ESTIMATE);

    for (const section of sections) {
      const text = section.lines.join("\n");
      if (text.trim().length === 0) {
        continue;
      }
      const estimatedChars = section.lines.reduce(
        (sum, line) => sum + estimateStringChars(line) + 1,
        0,
      );

      if (estimatedChars <= maxChars) {
        // Section fits within budget — emit as a single chunk.
        chunks.push({
          startLine: section.startLine,
          endLine: section.endLine,
          text,
          hash: hashText(text),
          embeddingInput: buildTextEmbeddingInput(text),
        });
      } else {
        // Section too large — fallback to fixed-size sub-chunking.
        const subChunks = chunkFixedSize(text, { tokens: this.maxTokens, overlap: 0 });
        // Remap line numbers relative to the section start.
        for (const sub of subChunks) {
          sub.startLine = sub.startLine + section.startLine - 1;
          sub.endLine = sub.endLine + section.startLine - 1;
        }
        chunks.push(...subChunks);
      }
    }
    return chunks;
  }

  /**
   * Split the content into sections based on heading boundaries.
   * Headings at depth <= maxDepth are treated as split points.
   */
  private splitIntoSections(content: string): Section[] {
    const lines = content.split("\n");
    const sections: Section[] = [];
    let currentLines: string[] = [];
    let currentStart = 1;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const lineNo = i + 1;
      const match = HEADING_RE.exec(line);
      if (match && match[1] && match[1].length <= this.maxDepth) {
        // Flush current section before starting a new one.
        if (currentLines.length > 0) {
          sections.push({
            startLine: currentStart,
            endLine: lineNo - 1,
            lines: currentLines,
          });
        }
        currentLines = [line];
        currentStart = lineNo;
      } else {
        currentLines.push(line);
      }
    }
    // Flush remaining lines.
    if (currentLines.length > 0) {
      sections.push({
        startLine: currentStart,
        endLine: lines.length,
        lines: currentLines,
      });
    }
    return sections;
  }
}
