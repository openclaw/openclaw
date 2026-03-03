import { applyMMRToHybridResults, DEFAULT_MMR_CONFIG } from "./mmr.js";
import { applyTemporalDecayToHybridResults, DEFAULT_TEMPORAL_DECAY_CONFIG, } from "./temporal-decay.js";
export { DEFAULT_MMR_CONFIG };
export { DEFAULT_TEMPORAL_DECAY_CONFIG };
export function buildFtsQuery(raw) {
    const tokens = raw
        .match(/[\p{L}\p{N}_]+/gu)
        ?.map((t) => t.trim())
        .filter(Boolean) ?? [];
    if (tokens.length === 0) {
        return null;
    }
    const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
    return quoted.join(" AND ");
}
export function bm25RankToScore(rank) {
    const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
    return 1 / (1 + normalized);
}
export async function mergeHybridResults(params) {
    const byId = new Map();
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
        }
        else {
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
    const merged = Array.from(byId.values()).map((entry) => {
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
