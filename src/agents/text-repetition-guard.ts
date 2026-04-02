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

/** Fully resolved (all-required) config. */
export type ResolvedTextRepetitionGuardConfig = Required<TextRepetitionGuardConfig>;

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

export function resolveConfig(
  partial?: TextRepetitionGuardConfig,
): ResolvedTextRepetitionGuardConfig {
  const merged = { ...DEFAULT_TEXT_REPETITION_GUARD_CONFIG, ...partial };
  // Sanitize numeric config to prevent infinite loops / nonsensical values.
  merged.minCyclePatternLength = Math.max(1, merged.minCyclePatternLength);
  merged.maxCyclePatternLength = Math.max(
    merged.minCyclePatternLength,
    merged.maxCyclePatternLength,
  );
  merged.ngramSize = Math.max(1, merged.ngramSize);
  merged.checkIntervalChars = Math.max(1, merged.checkIntervalChars);
  merged.windowSize = Math.max(100, merged.windowSize);
  merged.maxNgramRepetitions = Math.max(1, merged.maxNgramRepetitions);
  merged.maxIdenticalLines = Math.max(1, merged.maxIdenticalLines);
  merged.minCycleRepeats = Math.max(2, merged.minCycleRepeats);
  return merged;
}

function isFullyResolved(c: TextRepetitionGuardConfig): c is ResolvedTextRepetitionGuardConfig {
  return (
    c.enabled !== undefined &&
    c.windowSize !== undefined &&
    c.ngramSize !== undefined &&
    c.maxNgramRepetitions !== undefined &&
    c.maxIdenticalLines !== undefined &&
    c.minCyclePatternLength !== undefined &&
    c.maxCyclePatternLength !== undefined &&
    c.minCycleRepeats !== undefined &&
    c.checkIntervalChars !== undefined
  );
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
  config?: TextRepetitionGuardConfig | ResolvedTextRepetitionGuardConfig,
): TextRepetitionResult {
  // Skip re-resolving when caller already passed a fully resolved config.
  const cfg = config && isFullyResolved(config) ? config : resolveConfig(config);
  if (!cfg.enabled) {
    return { looping: false };
  }

  // Don't analyse tiny buffers — not enough signal.
  if (buffer.length < cfg.windowSize * 0.3) {
    return { looping: false };
  }

  const window = buffer.slice(-cfg.windowSize);

  // --- Strategy 1: N-gram frequency ---
  // Uses leading context to avoid false positives on templated output
  // (e.g. "Step 1: process item...", "Step 2: process item...") where
  // the 30-char stem repeats but surrounding content differs.
  {
    const ngrams = new Map<string, { count: number; lines: Set<string> }>();
    const step = Math.max(1, Math.floor(cfg.ngramSize / 3));
    const contextLen = Math.ceil(cfg.ngramSize / 2);
    // Pre-split lines for line-diversity lookup.
    const windowLines = window.split("\n");
    let charOffset = 0;
    const lineStartOffsets: number[] = [];
    for (const line of windowLines) {
      lineStartOffsets.push(charOffset);
      charOffset += line.length + 1; // +1 for '\n'
    }
    /** Find the full line text containing offset `pos`. */
    const lineAt = (pos: number): string => {
      let lo = 0;
      let hi = lineStartOffsets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStartOffsets[mid] <= pos) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      return windowLines[lo];
    };

    for (let i = 0; i <= window.length - cfg.ngramSize; i += step) {
      const gram = window.slice(i, i + cfg.ngramSize);
      if (isDegenerate(gram)) {
        continue;
      }
      // Include leading + trailing context in the map key so n-grams that
      // share a stem but appear in different surrounding text are counted
      // separately (e.g. "Step 1: do X..." vs "Step 2: do X...").
      const contextStart = Math.max(0, i - contextLen);
      const contextEnd = Math.min(window.length, i + cfg.ngramSize + contextLen);
      const contextualKey = window.slice(contextStart, contextEnd);
      const entry = ngrams.get(contextualKey) ?? { count: 0, lines: new Set<string>() };
      entry.count++;
      entry.lines.add(lineAt(i));
      if (entry.count >= cfg.maxNgramRepetitions) {
        // Line-diversity escape: if the repeated ngrams come from many
        // distinct lines, this is progressive content (e.g. numbered steps
        // that share a long suffix) rather than a true loop.
        if (entry.lines.size > entry.count / 2) {
          ngrams.set(contextualKey, entry);
          continue;
        }
        const msg = `Text repetition detected (ngram): pattern repeated ${entry.count} times`;
        log.warn(msg, { pattern: gram.slice(0, 60) });
        return {
          looping: true,
          detector: "ngram",
          pattern: gram.slice(0, 80),
          count: entry.count,
          message: msg,
        };
      }
      ngrams.set(contextualKey, entry);
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
    const maxP = Math.min(cfg.maxCyclePatternLength, Math.floor(tail.length / cfg.minCycleRepeats));
    for (let pLen = cfg.minCyclePatternLength; pLen <= maxP; pLen++) {
      const pat = tail.slice(-pLen);
      if (isDegenerate(pat)) {
        continue;
      }
      let repeats = 0;
      for (let i = tail.length - pLen; i >= 0; i -= pLen) {
        if (tail.slice(i, i + pLen) === pat) {
          repeats++;
          if (repeats >= cfg.minCycleRepeats) {
            break;
          }
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
    // Minimum lines needed: smallest group size (2) * minCycleRepeats
    const minLinesNeeded = 2 * cfg.minCycleRepeats;
    if (nonEmpty.length >= minLinesNeeded) {
      for (let groupSize = 2; groupSize <= 5; groupSize++) {
        const lastGroup = nonEmpty.slice(-groupSize);
        // Skip groups where every line is too short to carry real signal.
        if (lastGroup.every((l) => l.trim().length <= 5)) {
          continue;
        }
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
