import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../../utils/cjk-chars.js";
import { buildTextEmbeddingInput } from "../embedding-inputs.js";
import { hashText } from "./hash.js";
import type { MemoryChunk } from "./types.js";
import type { ChunkingStrategy, ChunkingConfig } from "./types.js";

/** Default target token count per chunk. */
export const DEFAULT_TARGET_TOKENS = 400;

/** Default number of overlap sentences carried to the next chunk. */
export const DEFAULT_OVERLAP_SENTENCES = 1;

/**
 * Matches the punctuation part of a sentence boundary (retained in text as separator).
 *
 * Group 1 — terminator cluster:
 *   - One or more sentence-ending characters: . ! ? 。 ！ ？ ； ; …
 *   - Optionally followed by closing brackets/quotes
 *
 * Does NOT match a lone ASCII dot followed by a lowercase letter or digit
 * (abbreviation / decimal guard).
 */
export const SENTENCE_TERMINATOR_RE = /([.!?。！？；;…]+[\])）」』〉》】»›"'"']*)/g;

/**
 * Full sentence-boundary detector used in splitIntoSentences().
 *
 * Wraps SENTENCE_TERMINATOR_RE with a trailing whitespace capture group so
 * the caller can:
 *   - Include match[1] (terminator) in the sentence text  ← separator retained
 *   - Skip match[2] (whitespace) when advancing the cursor
 *
 * Capture groups:
 *   [1]  sentence-ending punctuation + closing brackets  (keep in text)
 *   [2]  trailing whitespace                             (skip, don't include)
 */
export const SENTENCE_BOUNDARY_RE = /([.!?。！？；;…]+[\])）」』〉》】»›"'"']*)(\s*)/g;

type SentenceEntry = {
  text: string;
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
  chars: number; // estimated chars (CJK-aware)
};

/**
 * Sentence-based chunking strategy.
 *
 * Splits content into sentences, then accumulates sentences until the token
 * budget (`targetTokens`) is reached. Supports sentence-level overlap.
 */
export class SentenceStrategy implements ChunkingStrategy {
  readonly name = "sentence" as const;
  private readonly config: ChunkingConfig;
  private readonly targetTokens: number;
  private readonly overlapSentences: number;

  constructor(config: ChunkingConfig) {
    this.config = config;
    this.targetTokens = config.targetTokens ?? DEFAULT_TARGET_TOKENS;
    this.overlapSentences = config.overlapSentences ?? DEFAULT_OVERLAP_SENTENCES;
  }

  chunk(content: string, _cfg: ChunkingConfig): MemoryChunk[] {
    const sentences = splitIntoSentences(content);
    if (sentences.length === 0) {
      return [];
    }

    const maxChars = Math.max(32, this.targetTokens * CHARS_PER_TOKEN_ESTIMATE);
    const chunks: MemoryChunk[] = [];
    let current: SentenceEntry[] = [];
    let currentChars = 0;

    const flush = () => {
      if (current.length === 0) {
        return;
      }
      const first = current[0];
      const last = current[current.length - 1];
      const text = current.map((s) => s.text).join("\n");
      chunks.push({
        startLine: first.startLine,
        endLine: last.endLine,
        text,
        hash: hashText(text),
        embeddingInput: buildTextEmbeddingInput(text),
      });
    };

    const carryOverlap = () => {
      if (this.overlapSentences <= 0 || current.length === 0) {
        current = [];
        currentChars = 0;
        return;
      }
      const kept = current.slice(-this.overlapSentences);
      current = kept;
      currentChars = kept.reduce((sum, s) => sum + s.chars, 0);
    };

    for (const sentence of sentences) {
      if (currentChars + sentence.chars > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push(sentence);
      currentChars += sentence.chars;
    }
    flush();
    return chunks;
  }
}

/**
 * Split content into sentence entries, preserving line number information.
 *
 * Sentence boundaries are detected in two ways:
 *   1. Sentence-ending punctuation (. ! ? 。 ！ ？ etc.) — separator retained in text.
 *   2. Newline characters — each non-empty line is treated as a boundary.
 *      If the line already ended with punctuation the punctuation boundary
 *      fires first (via SENTENCE_BOUNDARY_RE), and the newline boundary
 *      fires as a fallback for lines with no terminal punctuation.
 *
 * Empty lines act as paragraph separators and are skipped (not emitted as entries).
 *
 * The sentence text retains its trailing terminator punctuation (separator
 * retained) but strips leading/trailing whitespace.
 */
export function splitIntoSentences(content: string): SentenceEntry[] {
  const lines = content.split("\n");
  const entries: SentenceEntry[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;

    // Empty lines are paragraph separators — skip, emit nothing.
    if (line.trim().length === 0) {
      continue;
    }

    // Scan the line for intra-line sentence boundaries (punctuation).
    // SENTENCE_BOUNDARY_RE capture groups:
    //   [1]  terminator punctuation + closing brackets  → kept in sentence text
    //   [2]  trailing whitespace                        → skipped (cursor advance only)
    let lastEnd = 0;
    SENTENCE_BOUNDARY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = SENTENCE_BOUNDARY_RE.exec(line)) !== null) {
      // terminatorEnd: just after punctuation (separator retained in text).
      // fullMatchEnd:  after trailing whitespace (advance cursor past it).
      const terminatorEnd = match.index + (match[1]?.length ?? 0);
      const fullMatchEnd = match.index + match[0].length;

      const sentenceText = line.slice(lastEnd, terminatorEnd).trim();
      const terminator = match[1] ?? "";
      if (/^\.+$/.test(terminator) && sentenceText.length <= 10) {
        // skip short sentences and special cases like "1. xxx", "a. xxx"
        continue;
      }
      if (sentenceText.length > 0) {
        entries.push({
          text: sentenceText,
          startLine: lineNo,
          endLine: lineNo,
          chars: estimateStringChars(sentenceText) + 1,
        });
      }
      lastEnd = fullMatchEnd;
    }

    // The remainder of the line (after the last punctuation boundary, or the
    // whole line if no punctuation was found) is treated as a sentence whose
    // boundary is the newline itself.
    const remainder = line.slice(lastEnd).trim();
    if (remainder.length > 0) {
      entries.push({
        text: remainder,
        startLine: lineNo,
        endLine: lineNo,
        chars: estimateStringChars(remainder) + 1,
      });
    }
  }

  return entries;
}
