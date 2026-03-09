/**
 * Text Repetition Guard
 *
 * Detects and aborts repetitive text generation loops in LLM output.
 * Complements tool-loop-detection (which only monitors tool calls) by
 * catching "text loops" where a model gets stuck emitting the same
 * patterns without invoking any tools.
 *
 * Intended integration point: the streaming message handler, after each
 * text chunk is appended to the delta buffer.
 */

import type { TextRepetitionGuardConfig } from "../config/types.tools.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/text-repetition-guard");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type { TextRepetitionGuardConfig } from "../config/types.tools.js";

/** Fully resolved (all-required) internal config. */
type ResolvedTextRepetitionGuardConfig = Required<TextRepetitionGuardConfig>;

export const DEFAULT_TEXT_REPETITION_GUARD_CONFIG: ResolvedTextRepetitionGuardConfig = {
  enabled: true,
  windowSize: 2000,
  ngramSize: 30,
  maxNgramRepetitions: 6,
  maxIdenticalLines: 8,
  minCyclePatternLength: 10,
  maxCyclePatternLength: 150,
  minCycleRepeats: 4,
  checkIntervalChars: 200,
};

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type TextRepetitionDetectorKind =
  | "ngram"
  | "identical_lines"
  | "suffix_cycle"
  | "line_group_cycle";

export type TextRepetitionResult =
  | { looping: false }
  | {
      looping: true;
      detector: TextRepetitionDetectorKind;
      pattern: string;
      count: number;
      message: string;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveConfig(partial?: TextRepetitionGuardConfig): ResolvedTextRepetitionGuardConfig {
  const merged = { ...DEFAULT_TEXT_REPETITION_GUARD_CONFIG, ...partial };
  // Sanitize numeric config to prevent infinite loops / nonsensical values.
  merged.minCyclePatternLength = Math.max(1, merged.minCyclePatternLength);
  merged.maxCyclePatternLength = Math.max(
    merged.minCyclePatternLength,
    merged.maxCyclePatternLength,
  );
  merged.ngramSize = Math.max(1, merged.ngramSize);
  merged.checkIntervalChars = Math.max(1, merged.checkIntervalChars);
  return merged;
}

/** True when a string is mostly whitespace or a single repeated character. */
function isDegenerate(s: string, minDensity = 0.3): boolean {
  const stripped = s.replace(/\s/g, "");
  if (stripped.length < s.length * minDensity) {
    return true;
  }
  // A pattern made of ≤2 distinct chars (after whitespace removal) is trivial
  // noise — but only skip it when it's too short to carry real signal.
  // Short strings (≤ ngramSize default) with 2 unique chars are degenerate;
  // longer strings with exactly 2 unique chars may still be a real repetition.
  if (stripped.length <= 30 && new Set(stripped).size <= 2) {
    return true;
  }
  if (new Set(stripped).size <= 1) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detectTextRepetition(
  buffer: string,
  config?: TextRepetitionGuardConfig,
): TextRepetitionResult {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) {
    return { looping: false };
  }

  // Don't analyse tiny buffers — not enough signal.
  if (buffer.length < cfg.windowSize * 0.3) {
    return { looping: false };
  }

  const window = buffer.slice(-cfg.windowSize);

  // --- Strategy 1: N-gram frequency ---
  {
    const ngrams = new Map<string, number>();
    const step = Math.max(1, Math.floor(cfg.ngramSize / 3));
    for (let i = 0; i <= window.length - cfg.ngramSize; i += step) {
      const gram = window.slice(i, i + cfg.ngramSize);
      if (isDegenerate(gram)) {
        continue;
      }
      const count = (ngrams.get(gram) ?? 0) + 1;
      if (count >= cfg.maxNgramRepetitions) {
        const msg = `Text repetition detected (ngram): pattern repeated ${count} times`;
        log.warn(msg, { pattern: gram.slice(0, 60) });
        return {
          looping: true,
          detector: "ngram",
          pattern: gram.slice(0, 80),
          count,
          message: msg,
        };
      }
      ngrams.set(gram, count);
    }
  }

  // --- Strategy 2: Consecutive identical non-empty lines ---
  {
    const lines = window.split("\n");
    let consecutive = 1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === lines[i - 1] && lines[i].trim().length > 5) {
        consecutive++;
        if (consecutive >= cfg.maxIdenticalLines) {
          const msg = `Text repetition detected (identical lines): ${consecutive} consecutive identical lines`;
          log.warn(msg, { line: lines[i].slice(0, 60) });
          return {
            looping: true,
            detector: "identical_lines",
            pattern: lines[i].slice(0, 80),
            count: consecutive,
            message: msg,
          };
        }
      } else {
        consecutive = 1;
      }
    }
  }

  // --- Strategy 3: Suffix cycle ---
  {
    const tail = window.slice(-600);
    const maxP = Math.min(cfg.maxCyclePatternLength, Math.floor(tail.length / 3));
    for (let pLen = cfg.minCyclePatternLength; pLen <= maxP; pLen++) {
      const pat = tail.slice(-pLen);
      if (isDegenerate(pat)) {
        continue;
      }
      let repeats = 0;
      for (let i = tail.length - pLen; i >= 0; i -= pLen) {
        if (tail.slice(i, i + pLen) === pat) {
          repeats++;
        } else {
          break;
        }
      }
      if (repeats >= cfg.minCycleRepeats) {
        const msg = `Text repetition detected (suffix cycle): pattern of length ${pLen} repeated ${repeats} times`;
        log.warn(msg, { pattern: pat.slice(0, 60) });
        return {
          looping: true,
          detector: "suffix_cycle",
          pattern: pat.slice(0, 80),
          count: repeats,
          message: msg,
        };
      }
    }
  }

  // --- Strategy 4: Line-group cycle ---
  {
    const nonEmpty = window.split("\n").filter((l) => l.trim().length > 0);
    if (nonEmpty.length >= 12) {
      for (let groupSize = 2; groupSize <= 5; groupSize++) {
        const lastGroup = nonEmpty.slice(-groupSize);
        let groupRepeats = 0;
        for (let i = nonEmpty.length - groupSize; i >= 0; i -= groupSize) {
          const block = nonEmpty.slice(i, i + groupSize);
          if (
            block.length === lastGroup.length &&
            block.every((line, idx) => line === lastGroup[idx])
          ) {
            groupRepeats++;
          } else {
            break;
          }
        }
        if (groupRepeats >= cfg.minCycleRepeats) {
          const patternPreview = lastGroup.join(" | ").slice(0, 80);
          const msg = `Text repetition detected (line group cycle): group of ${groupSize} lines repeated ${groupRepeats} times`;
          log.warn(msg, { pattern: patternPreview });
          return {
            looping: true,
            detector: "line_group_cycle",
            pattern: patternPreview,
            count: groupRepeats,
            message: msg,
          };
        }
      }
    }
  }

  return { looping: false };
}
