import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
export function isMissingEmbeddingApiKeyError(err) {
    return err instanceof Error && err.message.includes("No API key found for provider");
}
export function sanitizeEmbeddingCacheHeaders(headers, excludedHeaderNames) {
    const excluded = new Set(excludedHeaderNames.map((name) => normalizeLowercaseStringOrEmpty(name)));
    return Object.entries(headers)
        .filter(([key]) => !excluded.has(normalizeLowercaseStringOrEmpty(key)))
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value]);
}
export function mapBatchEmbeddingsByIndex(byCustomId, count) {
    const embeddings = [];
    for (let index = 0; index < count; index += 1) {
        embeddings.push(byCustomId.get(String(index)) ?? []);
    }
    return embeddings;
}
