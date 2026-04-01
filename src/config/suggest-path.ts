/**
 * suggest-path.ts
 *
 * Provides "Did you mean ...?" suggestions when users enter an invalid
 * config path in `openclaw config get` or `openclaw config unset`.
 *
 * Uses Levenshtein edit-distance to find the closest known paths from
 * the FIELD_HELP registry (the single source of truth for documented
 * config keys).
 */

import { FIELD_HELP } from "./schema.help.js";

// ---------------------------------------------------------------------------
// Edit-distance (Levenshtein) – single-row DP, O(n·m) time, O(m) space.
// Intentionally self-contained so this module has no dependency on the
// security subsystem where a similar helper lives.
// ---------------------------------------------------------------------------

/**
 * Compute the Levenshtein edit-distance between two strings.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a) {
    return b.length;
  }
  if (!b) {
    return a.length;
  }

  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }

  return dp[b.length];
}

// ---------------------------------------------------------------------------
// Path suggestion
// ---------------------------------------------------------------------------

/** Maximum edit-distance to consider a path as a valid suggestion. */
const MAX_DISTANCE = 3;

/** Maximum number of suggestions to return. */
const MAX_SUGGESTIONS = 3;

/**
 * Collect all known config paths from the FIELD_HELP registry.
 *
 * The result is cached after first call because FIELD_HELP is a static
 * compile-time constant that never changes at runtime.
 */
let cachedKnownPaths: string[] | null = null;

function getKnownConfigPaths(): string[] {
  if (cachedKnownPaths) {
    return cachedKnownPaths;
  }
  cachedKnownPaths = Object.keys(FIELD_HELP);
  return cachedKnownPaths;
}

/**
 * Find config paths that are similar to the given unknown path.
 *
 * Strategy:
 *  1. Exact prefix match – if the input is a valid prefix of known paths,
 *     those are returned first (handles truncated paths like "gateway.au").
 *  2. Edit-distance – for each known path, compute the Levenshtein distance
 *     to the input. Paths within MAX_DISTANCE are collected and sorted by
 *     distance ascending, then alphabetically for ties.
 *  3. Segment-level match – compare the last segment of the input against
 *     last segments of all known paths to catch cases like
 *     "channels.telegram.tken" vs "channels.telegram.token".
 *
 * Returns an empty array when no close match exists.
 */
export function suggestConfigPaths(unknownPath: string): string[] {
  const needle = unknownPath.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const knownPaths = getKnownConfigPaths();

  // --- Phase 1: prefix matches (input is a truncated known path) -----------
  const prefixMatches = knownPaths.filter((known) => known.toLowerCase().startsWith(needle + "."));
  if (prefixMatches.length > 0) {
    return prefixMatches.slice(0, MAX_SUGGESTIONS);
  }

  // --- Phase 2: full-path edit-distance ------------------------------------
  type Candidate = { path: string; distance: number };
  const candidates: Candidate[] = [];

  for (const known of knownPaths) {
    const distance = editDistance(needle, known.toLowerCase());
    if (distance <= MAX_DISTANCE) {
      candidates.push({ path: known, distance });
    }
  }

  // --- Phase 3: last-segment edit-distance ---------------------------------
  // Handles "gateway.auth.tken" → "gateway.auth.token" where the full-path
  // distance may exceed MAX_DISTANCE but the last segment is very close.
  const needleParts = needle.split(".");
  if (needleParts.length >= 2) {
    const needlePrefix = needleParts.slice(0, -1).join(".");
    const needleTail = needleParts[needleParts.length - 1] ?? "";

    for (const known of knownPaths) {
      const knownLower = known.toLowerCase();
      // Only consider paths that share the same prefix.
      if (!knownLower.startsWith(needlePrefix + ".")) {
        continue;
      }
      const knownParts = knownLower.split(".");
      // Restrict to same depth to avoid cross-level false positives (Codex review).
      if (knownParts.length !== needleParts.length) {
        continue;
      }
      const knownTail = knownParts[knownParts.length - 1] ?? "";
      const tailDistance = editDistance(needleTail, knownTail);
      if (tailDistance > 0 && tailDistance <= MAX_DISTANCE) {
        // Use tail distance as the sort key so segment-level matches
        // compete fairly with full-path matches.
        const alreadyPresent = candidates.some((c) => c.path === known);
        if (!alreadyPresent) {
          candidates.push({ path: known, distance: tailDistance });
        }
      }
    }
  }

  if (candidates.length === 0) {
    return [];
  }

  // Sort by distance first, then alphabetically for deterministic output.
  candidates.sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path));

  // Dedupe (shouldn't be needed but guard against edge cases).
  const seen = new Set<string>();
  const results: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) {
      continue;
    }
    seen.add(candidate.path);
    results.push(candidate.path);
    if (results.length >= MAX_SUGGESTIONS) {
      break;
    }
  }

  return results;
}

/**
 * Build a human-readable hint string for an unknown config path.
 *
 * Returns `null` when no suggestion is available, so callers can skip
 * printing an empty hint.
 *
 * Example output:
 *   'Did you mean: gateway.auth.token?'
 *   'Did you mean one of: gateway.port, gateway.auth.token, gateway.auth.mode?'
 */
export function buildConfigPathSuggestionHint(unknownPath: string): string | null {
  const suggestions = suggestConfigPaths(unknownPath);
  if (suggestions.length === 0) {
    return null;
  }
  if (suggestions.length === 1) {
    return `Did you mean: ${suggestions[0]}?`;
  }
  return `Did you mean one of: ${suggestions.join(", ")}?`;
}
