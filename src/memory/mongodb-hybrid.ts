/**
 * MongoDB-specific hybrid search merge with OR-join FTS and Reciprocal Rank Fusion.
 *
 * Replaces upstream hybrid.ts for the MongoDB backend to fix:
 * - AND-join FTS bug (#16021) that drops hit rate from 95% to 40%
 * - Weighted average scoring that penalizes vector results when BM25=0
 * - Score normalization gap when merging results from different search methods
 *
 * @module memory:mongodb:hybrid
 */

import type { MemorySearchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Search method classification for score normalization
// ---------------------------------------------------------------------------

export type SearchMethod = "vector" | "text" | "hybrid" | "structured" | "kb";

// ---------------------------------------------------------------------------
// OR-join FTS query builder (replaces upstream AND-join)
// ---------------------------------------------------------------------------

/**
 * Build a full-text search query string using OR-join instead of AND-join.
 *
 * Upstream hybrid.ts AND-joins all tokens: `"word1" AND "word2" AND "word3"`.
 * This requires ALL tokens to match, which kills recall for natural language queries.
 *
 * Our OR-join: `"word1" OR "word2" OR "word3"` matches ANY token, improving recall
 * from ~40% to ~95% for natural language queries.
 */
export function buildOrJoinFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[A-Za-z0-9_]+/g)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF) scoring
// ---------------------------------------------------------------------------

/** Default RRF constant. Standard value from the original RRF paper. */
const DEFAULT_RRF_K = 60;

/**
 * Compute the RRF score for a result at a given rank.
 *
 * Formula: `1 / (k + rank)` where k defaults to 60.
 *
 * Properties:
 * - Top-ranked result (rank=1) scores 1/61 ~ 0.0164
 * - Scores decrease smoothly with rank
 * - Results appearing in multiple lists get their RRF scores summed
 * - k=60 dampens the influence of high-ranked results, producing more uniform fusion
 */
export function rrfScore(rank: number, k: number = DEFAULT_RRF_K): number {
  return 1 / (k + rank);
}

// ---------------------------------------------------------------------------
// Score normalization utilities
// ---------------------------------------------------------------------------

/**
 * Normalize a vector search score (cosine similarity).
 *
 * Cosine similarity from $vectorSearch is already in [0,1] range,
 * but we clamp to handle edge cases and non-finite values.
 */
export function normalizeVectorScore(score: number): number {
  if (!Number.isFinite(score)) {
    return score > 0 ? 1.0 : 0.0;
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * Normalize a BM25/TF-IDF text search score from [0, inf) to [0, 1].
 *
 * Uses a sigmoid-like function: `score / (score + k)` where k controls
 * the midpoint. With k=5, a BM25 score of 5 maps to 0.5.
 *
 * This provides a smooth, monotonically increasing mapping that:
 * - Maps 0 to 0
 * - Approaches 1 for very high scores
 * - Has a reasonable midpoint for typical BM25 scores (range 1-20)
 */
export function normalizeBM25Score(score: number, k: number = 5): number {
  if (!Number.isFinite(score) || score < 0) {
    return 0;
  }
  return score / (score + k);
}

/**
 * Normalize an RRF score to [0, 1] range.
 *
 * Raw RRF scores are in [0, 1/k] where k is the RRF constant (default 60).
 * The maximum possible RRF score is 1/k (for rank=0, which is rare) or
 * more typically 1/(k+1) for rank=1.
 *
 * We normalize by dividing by the theoretical maximum (1/k) so that
 * the top-ranked result approaches 1.0.
 */
export function normalizeRRFScore(score: number, k: number = DEFAULT_RRF_K): number {
  if (!Number.isFinite(score) || score <= 0) {
    return 0;
  }
  const maxScore = 1 / k;
  return Math.min(1, score / maxScore);
}

// ---------------------------------------------------------------------------
// Hybrid merge with RRF (drop-in replacement for upstream mergeHybridResults)
// ---------------------------------------------------------------------------

/**
 * Merge vector and keyword search results using Reciprocal Rank Fusion (RRF).
 *
 * Unlike the upstream weighted average (`w*vector + (1-w)*text`), RRF:
 * - Does not penalize results that appear in only one list
 * - Handles incompatible score scales naturally (rank-based, not score-based)
 * - Boosts results that appear in BOTH lists (sum of RRF scores)
 *
 * This replaces upstream `mergeHybridResults()` for the MongoDB backend.
 */
export function mergeHybridResultsMongoDB(params: {
  vector: MemorySearchResult[];
  keyword: MemorySearchResult[];
  maxResults: number;
}): MemorySearchResult[] {
  const { vector, keyword, maxResults } = params;

  if (vector.length === 0 && keyword.length === 0) {
    return [];
  }

  // Build a map of id -> accumulated RRF score + metadata
  const byId = new Map<
    string,
    {
      path: string;
      startLine: number;
      endLine: number;
      source: MemorySearchResult["source"];
      snippet: string;
      rrfSum: number;
    }
  >();

  // Assign RRF scores based on rank in vector results
  for (let rank = 0; rank < vector.length; rank++) {
    const r = vector[rank];
    const id = `${r.path}:${r.startLine}:${r.endLine}`;
    const existing = byId.get(id);
    const rScore = rrfScore(rank + 1); // 1-based rank
    if (existing) {
      existing.rrfSum += rScore;
    } else {
      byId.set(id, {
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        rrfSum: rScore,
      });
    }
  }

  // Assign RRF scores based on rank in keyword results
  for (let rank = 0; rank < keyword.length; rank++) {
    const r = keyword[rank];
    const id = `${r.path}:${r.startLine}:${r.endLine}`;
    const existing = byId.get(id);
    const rScore = rrfScore(rank + 1); // 1-based rank
    if (existing) {
      existing.rrfSum += rScore;
      // Prefer keyword snippet (usually has better relevance highlighting)
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
    } else {
      byId.set(id, {
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        rrfSum: rScore,
      });
    }
  }

  // Normalize RRF scores to [0,1] and sort descending
  // Maximum possible sum is 2 * 1/(k+1) when a result is ranked #1 in both lists
  const maxPossibleSum = 2 * rrfScore(1);

  const merged = Array.from(byId.values())
    .map((entry) => ({
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score: Number(Math.min(1, entry.rrfSum / maxPossibleSum).toFixed(6)),
      snippet: entry.snippet,
      source: entry.source,
    }))
    .toSorted((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return merged;
}

// ---------------------------------------------------------------------------
// Cross-source score normalization
// ---------------------------------------------------------------------------

/**
 * Normalize search results to [0,1] range based on the search method that
 * produced them.
 *
 * This is the key function for fixing the score normalization gap (F23).
 * Different search methods produce scores on different scales:
 * - vector ($vectorSearch): cosine similarity [0, 1]
 * - text ($search, $text): BM25/TF-IDF [0, inf)
 * - hybrid ($rankFusion/$scoreFusion): depends on fusion method
 * - structured: same as vector (uses $vectorSearch or $text fallback)
 * - kb: same as vector (uses $vectorSearch or $text fallback)
 *
 * After normalization, results from all methods can be merged and sorted
 * on a common [0,1] scale.
 */
export function normalizeSearchResults(
  results: MemorySearchResult[],
  method: SearchMethod,
): MemorySearchResult[] {
  if (results.length === 0) {
    return [];
  }

  const normalizer = getNormalizer(method);

  return results.map((r) => ({
    ...r,
    score: normalizer(r.score),
  }));
}

function getNormalizer(method: SearchMethod): (score: number) => number {
  switch (method) {
    case "vector":
    case "structured":
    case "kb":
      // These use $vectorSearch or server-side fusion, scores are [0,1]-ish
      return normalizeVectorScore;
    case "text":
      // BM25/TF-IDF scores are unbounded [0, inf)
      return normalizeBM25Score;
    case "hybrid":
      // Both server-side fusion ($rankFusion/$scoreFusion) and our JS-merge
      // (mergeHybridResultsMongoDB) already produce scores in ~[0,1].
      // Use identity clamp rather than RRF scaling which would multiply by 60
      // and flatten all scores to 1.0.
      return normalizeVectorScore;
    default:
      return normalizeVectorScore;
  }
}
