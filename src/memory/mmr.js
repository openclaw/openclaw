/**
 * Maximal Marginal Relevance (MMR) re-ranking algorithm.
 *
 * MMR balances relevance with diversity by iteratively selecting results
 * that maximize: λ * relevance - (1-λ) * max_similarity_to_selected
 *
 * @see Carbonell & Goldstein, "The Use of MMR, Diversity-Based Reranking" (1998)
 */
export const DEFAULT_MMR_CONFIG = {
    enabled: false,
    lambda: 0.7,
};
/**
 * Tokenize text for Jaccard similarity computation.
 * Extracts alphanumeric tokens and normalizes to lowercase.
 */
export function tokenize(text) {
    const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    return new Set(tokens);
}
/**
 * Compute Jaccard similarity between two token sets.
 * Returns a value in [0, 1] where 1 means identical sets.
 */
export function jaccardSimilarity(setA, setB) {
    if (setA.size === 0 && setB.size === 0) {
        return 1;
    }
    if (setA.size === 0 || setB.size === 0) {
        return 0;
    }
    let intersectionSize = 0;
    const smaller = setA.size <= setB.size ? setA : setB;
    const larger = setA.size <= setB.size ? setB : setA;
    for (const token of smaller) {
        if (larger.has(token)) {
            intersectionSize++;
        }
    }
    const unionSize = setA.size + setB.size - intersectionSize;
    return unionSize === 0 ? 0 : intersectionSize / unionSize;
}
/**
 * Compute text similarity between two content strings using Jaccard on tokens.
 */
export function textSimilarity(contentA, contentB) {
    return jaccardSimilarity(tokenize(contentA), tokenize(contentB));
}
/**
 * Compute the maximum similarity between an item and all selected items.
 */
function maxSimilarityToSelected(item, selectedItems, tokenCache) {
    if (selectedItems.length === 0) {
        return 0;
    }
    let maxSim = 0;
    const itemTokens = tokenCache.get(item.id) ?? tokenize(item.content);
    for (const selected of selectedItems) {
        const selectedTokens = tokenCache.get(selected.id) ?? tokenize(selected.content);
        const sim = jaccardSimilarity(itemTokens, selectedTokens);
        if (sim > maxSim) {
            maxSim = sim;
        }
    }
    return maxSim;
}
/**
 * Compute MMR score for a candidate item.
 * MMR = λ * relevance - (1-λ) * max_similarity_to_selected
 */
export function computeMMRScore(relevance, maxSimilarity, lambda) {
    return lambda * relevance - (1 - lambda) * maxSimilarity;
}
/**
 * Re-rank items using Maximal Marginal Relevance (MMR).
 *
 * The algorithm iteratively selects items that balance relevance with diversity:
 * 1. Start with the highest-scoring item
 * 2. For each remaining slot, select the item that maximizes the MMR score
 * 3. MMR score = λ * relevance - (1-λ) * max_similarity_to_already_selected
 *
 * @param items - Items to re-rank, must have score and content
 * @param config - MMR configuration (lambda, enabled)
 * @returns Re-ranked items in MMR order
 */
export function mmrRerank(items, config = {}) {
    const { enabled = DEFAULT_MMR_CONFIG.enabled, lambda = DEFAULT_MMR_CONFIG.lambda } = config;
    // Early exits
    if (!enabled || items.length <= 1) {
        return [...items];
    }
    // Clamp lambda to valid range
    const clampedLambda = Math.max(0, Math.min(1, lambda));
    // If lambda is 1, just return sorted by relevance (no diversity penalty)
    if (clampedLambda === 1) {
        return [...items].toSorted((a, b) => b.score - a.score);
    }
    // Pre-tokenize all items for efficiency
    const tokenCache = new Map();
    for (const item of items) {
        tokenCache.set(item.id, tokenize(item.content));
    }
    // Normalize scores to [0, 1] for fair comparison with similarity
    const maxScore = Math.max(...items.map((i) => i.score));
    const minScore = Math.min(...items.map((i) => i.score));
    const scoreRange = maxScore - minScore;
    const normalizeScore = (score) => {
        if (scoreRange === 0) {
            return 1; // All scores equal
        }
        return (score - minScore) / scoreRange;
    };
    const selected = [];
    const remaining = new Set(items);
    // Select items iteratively
    while (remaining.size > 0) {
        let bestItem = null;
        let bestMMRScore = -Infinity;
        for (const candidate of remaining) {
            const normalizedRelevance = normalizeScore(candidate.score);
            const maxSim = maxSimilarityToSelected(candidate, selected, tokenCache);
            const mmrScore = computeMMRScore(normalizedRelevance, maxSim, clampedLambda);
            // Use original score as tiebreaker (higher is better)
            if (mmrScore > bestMMRScore ||
                (mmrScore === bestMMRScore && candidate.score > (bestItem?.score ?? -Infinity))) {
                bestMMRScore = mmrScore;
                bestItem = candidate;
            }
        }
        if (bestItem) {
            selected.push(bestItem);
            remaining.delete(bestItem);
        }
        else {
            // Should never happen, but safety exit
            break;
        }
    }
    return selected;
}
/**
 * Apply MMR re-ranking to hybrid search results.
 * Adapts the generic MMR function to work with the hybrid search result format.
 */
export function applyMMRToHybridResults(results, config = {}) {
    if (results.length === 0) {
        return results;
    }
    // Create a map from ID to original item for type-safe retrieval
    const itemById = new Map();
    // Create MMR items with unique IDs
    const mmrItems = results.map((r, index) => {
        const id = `${r.path}:${r.startLine}:${index}`;
        itemById.set(id, r);
        return {
            id,
            score: r.score,
            content: r.snippet,
        };
    });
    const reranked = mmrRerank(mmrItems, config);
    // Map back to original items using the ID
    return reranked.map((item) => itemById.get(item.id));
}
