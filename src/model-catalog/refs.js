import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
export function normalizeModelCatalogProviderId(provider) {
    return normalizeLowercaseStringOrEmpty(provider);
}
export function buildModelCatalogRef(provider, modelId) {
    return `${normalizeModelCatalogProviderId(provider)}/${modelId}`;
}
export function buildModelCatalogMergeKey(provider, modelId) {
    return `${normalizeModelCatalogProviderId(provider)}::${normalizeLowercaseStringOrEmpty(modelId)}`;
}
