import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../../utils/cjk-chars.js";
import { buildTextEmbeddingInput } from "../embedding-inputs.js";
import type { MemoryChunk } from "../internal.js";
import { hashText } from "./hash.js";
import type { ChunkingStrategy, LlmCompletionFn, ChunkingConfig } from "./types.js";

/** Default token threshold per paragraph group (from LumberChunker paper, θ=550). */
export const DEFAULT_LUMBER_THETA = 550;

type Paragraph = {
  id: number; // 1-based incremental ID
  text: string;
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
  estimatedTokens: number;
};

const LUMBER_SYSTEM_PROMPT = [
  "You will receive a document with paragraphs identified by '[ID XXXX]'.",
  "Task: Find the first paragraph (not the very first one in the group) where the content clearly changes compared to the previous paragraphs.",
  "Output: Do NOT output any other text or explanations. Only return the ID of the paragraph where content shifts, using the exact format: 'Answer: ID XXXX'.",
  "Additional Considerations: Avoid very long groups of paragraphs. Aim for a good balance between identifying content shifts and keeping groups manageable.",
  "If you see no clear content shift, respond with: 'Answer: NONE'.",
].join("\n");

const ANSWER_RE = /Answer:\s*ID\s*(\d+)/i;

/**
 * Split text into paragraphs on blank-line boundaries (one or more empty lines).
 * Each paragraph keeps its original line numbers (1-indexed).
 */
export function splitIntoParagraphs(content: string): Paragraph[] {
  const lines = content.split("\n");
  const paragraphs: Paragraph[] = [];

  let currentLines: { text: string; lineNo: number }[] = [];

  const flush = () => {
    if (currentLines.length === 0) {
      return;
    }
    const first = currentLines[0];
    const last = currentLines[currentLines.length - 1];
    const text = currentLines.map((l) => l.text).join("\n");
    const estimatedChars = estimateStringChars(text);
    paragraphs.push({
      id: paragraphs.length + 1,
      text,
      startLine: first.lineNo,
      endLine: last.lineNo,
      estimatedTokens: Math.max(1, Math.round(estimatedChars / CHARS_PER_TOKEN_ESTIMATE)),
    });
    currentLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      flush();
    } else {
      currentLines.push({ text: line, lineNo: i + 1 });
    }
  }
  flush();

  return paragraphs;
}

/**
 * Build the LLM prompt for a group of paragraphs.
 * Each paragraph is prefixed with `[ID XXXX]`.
 */
export function buildLumberPrompt(paragraphs: Paragraph[]): string {
  const header = LUMBER_SYSTEM_PROMPT;
  const body = paragraphs
    .map((p) => `[ID ${String(p.id).padStart(4, "0")}] ${p.text}`)
    .join("\n\n");
  return `${header}\n\nDocument:\n${body}`;
}

/**
 * Parse the LLM response to extract the shift-point paragraph ID.
 * Returns the numeric ID, or `null` if the response cannot be parsed or is NONE.
 */
export function parseShiftPointId(response: string): number | null {
  if (/Answer:\s*NONE/i.test(response)) {
    return null;
  }
  const match = ANSWER_RE.exec(response);
  if (!match?.[1]) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

/**
 * LumberChunker strategy — uses an LLM to identify content shift points
 * within consecutive paragraph groups.
 *
 * Based on "LumberChunker: Long-Form Narrative Document Segmentation"
 * (EMNLP 2024 Findings, arXiv:2406.17526).
 */
export class LumberChunkerStrategy implements ChunkingStrategy {
  readonly name = "lumber" as const;
  private readonly config: ChunkingConfig;
  private readonly theta: number;
  private readonly completionFn: LlmCompletionFn;

  constructor(config: ChunkingConfig, completionFn: LlmCompletionFn) {
    this.config = config;
    this.theta = config.theta ?? DEFAULT_LUMBER_THETA;
    this.completionFn = completionFn;
  }

  async chunk(content: string, _cfg: ChunkingConfig): Promise<MemoryChunk[]> {
    const paragraphs = splitIntoParagraphs(content);
    // Short-circuit: single or empty paragraph
    if (paragraphs.length <= 1) {
      return this.buildChunksFromRanges(paragraphs, [[0, paragraphs.length - 1]]);
    }

    const splitIndices = await this.findSplitPoints(paragraphs);
    const ranges = this.splitPointsToRanges(paragraphs.length, splitIndices);
    return this.buildChunksFromRanges(paragraphs, ranges);
  }

  /**
   * Iteratively identify split points by accumulating paragraphs into groups
   * that exceed the token threshold, then asking the LLM where the content shifts.
   */
  private async findSplitPoints(paragraphs: Paragraph[]): Promise<number[]> {
    const splitIndices: number[] = [];
    let cursor = 0;

    while (cursor < paragraphs.length) {
      // Accumulate paragraphs until tokens exceed theta
      let tokenSum = 0;
      let groupEnd = cursor;
      while (groupEnd < paragraphs.length) {
        tokenSum += paragraphs[groupEnd].estimatedTokens;
        groupEnd++;
        if (tokenSum >= this.theta) {
          break;
        }
      }

      // If we've reached the end of the document, no more splits needed
      if (groupEnd >= paragraphs.length) {
        break;
      }

      const group = paragraphs.slice(cursor, groupEnd);
      if (group.length <= 1) {
        // Single paragraph group: nothing to split, advance
        cursor = groupEnd;
        continue;
      }

      try {
        const prompt = buildLumberPrompt(group);
        const response = await this.completionFn(prompt);
        const shiftId = parseShiftPointId(response);
        if (shiftId !== null) {
          // Find the index of the paragraph with the returned ID
          const splitIdx = paragraphs.findIndex((p) => p.id === shiftId);
          if (splitIdx > cursor && splitIdx < groupEnd) {
            splitIndices.push(splitIdx);
            cursor = splitIdx;
            continue;
          }
        }
      } catch {
        // LLM call failed — treat entire group as one chunk, continue
      }

      // Fallback: no valid split found, advance past the group
      cursor = groupEnd;
    }

    return splitIndices;
  }

  /**
   * Convert split-point indices into [start, end] inclusive index ranges
   * covering all paragraphs.
   */
  private splitPointsToRanges(
    totalParagraphs: number,
    splitIndices: number[],
  ): Array<[number, number]> {
    const sorted = [...new Set(splitIndices)].toSorted((a, b) => a - b);
    const ranges: Array<[number, number]> = [];
    let start = 0;
    for (const idx of sorted) {
      if (idx > start) {
        ranges.push([start, idx - 1]);
      }
      start = idx;
    }
    if (start < totalParagraphs) {
      ranges.push([start, totalParagraphs - 1]);
    }
    return ranges;
  }

  /**
   * Build MemoryChunk array from paragraph index ranges.
   */
  private buildChunksFromRanges(
    paragraphs: Paragraph[],
    ranges: Array<[number, number]>,
  ): MemoryChunk[] {
    const chunks: MemoryChunk[] = [];
    for (const [start, end] of ranges) {
      const group = paragraphs.slice(start, end + 1);
      if (group.length === 0) {
        continue;
      }
      const text = group.map((p) => p.text).join("\n\n");
      const firstParagraph = group[0];
      const lastParagraph = group[group.length - 1];
      chunks.push({
        startLine: firstParagraph.startLine,
        endLine: lastParagraph.endLine,
        text,
        hash: hashText(text),
        embeddingInput: buildTextEmbeddingInput(text),
      });
    }
    return chunks;
  }
}
