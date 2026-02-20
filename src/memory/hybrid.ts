import { applyMMRToHybridResults, type MMRConfig, DEFAULT_MMR_CONFIG } from "./mmr.js";
import {
  applyTemporalDecayToHybridResults,
  type TemporalDecayConfig,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
} from "./temporal-decay.js";

export type HybridSource = string;

export { type MMRConfig, DEFAULT_MMR_CONFIG };
export { type TemporalDecayConfig, DEFAULT_TEMPORAL_DECAY_CONFIG };

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
};

export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}

export type HybridFusionMethod = "weighted" | "rrf";

export interface HybridFusionConfig {
  method?: HybridFusionMethod;
  rrfK?: number;
}

export function calculateRRFScore(ranks: number[], k: number = 60): number {
  let score = 0;
  for (const rank of ranks) {
    if (rank !== undefined && rank !== null) {
      score += 1 / (k + rank);
    }
  }
  return score;
}

export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  workspaceDir?: string;
  /** Fusion method for combining vector and keyword results */
  fusion?: HybridFusionMethod;
  /** RRF constant for Reciprocal Rank Fusion (default: 60) */
  rrfK?: number;
  /** MMR configuration for diversity-aware re-ranking */
  mmr?: Partial<MMRConfig>;
  /** Temporal decay configuration for recency-aware scoring */
  temporalDecay?: Partial<TemporalDecayConfig>;
  /** Test seam for deterministic time-dependent behavior */
  nowMs?: number;
}): Promise<
  Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: HybridSource;
  }>
> {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: HybridSource;
      snippet: string;
      vectorScore: number;
      textScore: number;
      vectorRank?: number;
      keywordRank?: number;
    }
  >();

  // Collect results and track ranks for RRF
  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
    } else {
      byId.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
      });
    }
  }

  // Prepare results for fusion
  const fusionMethod = params.fusion || "weighted";
  const rrfK = params.rrfK || 60;

  let merged: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: HybridSource;
  }>;

  if (fusionMethod === "rrf") {
    // RRF fusion: sort each source by score to get ranks, then calculate RRF score
    const vectorRanked = [...params.vector].sort((a, b) => b.vectorScore - a.vectorScore);
    const keywordRanked = [...params.keyword].sort((a, b) => b.textScore - a.textScore);
    
    // Create rank maps for RRF calculation
    const vectorRankMap = new Map<string, number>();
    const keywordRankMap = new Map<string, number>();
    
    vectorRanked.forEach((r, index) => {
      vectorRankMap.set(r.id, index + 1); // 1-indexed ranking
    });
    
    keywordRanked.forEach((r, index) => {
      keywordRankMap.set(r.id, index + 1);
    });

    merged = Array.from(byId.values()).map((entry) => {
      const ranks: number[] = [];
      const vectorRank = vectorRankMap.get(entry.id);
      const keywordRank = keywordRankMap.get(entry.id);
      
      if (vectorRank !== undefined) ranks.push(vectorRank);
      if (keywordRank !== undefined) ranks.push(keywordRank);
      
      const score = ranks.length > 0 ? calculateRRFScore(ranks, rrfK) : 0;
      return {
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        score,
        snippet: entry.snippet,
        source: entry.source,
      };
    });
  } else {
    // Default weighted fusion
    merged = Array.from(byId.values()).map((entry) => {
      const score = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
      return {
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        score,
        snippet: entry.snippet,
        source: entry.source,
      };
    });
  }

  const temporalDecayConfig = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  const decayed = await applyTemporalDecayToHybridResults({
    results: merged,
    temporalDecay: temporalDecayConfig,
    workspaceDir: params.workspaceDir,
    nowMs: params.nowMs,
  });
  const sorted = decayed.toSorted((a, b) => b.score - a.score);

  // Apply MMR re-ranking if enabled
  const mmrConfig = { ...DEFAULT_MMR_CONFIG, ...params.mmr };
  if (mmrConfig.enabled) {
    return applyMMRToHybridResults(sorted, mmrConfig);
  }

  return sorted;
}
