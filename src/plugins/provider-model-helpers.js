import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeModelCompat } from "./provider-model-compat.js";
export function matchesExactOrPrefix(id, values) {
    const normalizedId = normalizeLowercaseStringOrEmpty(id);
    return values.some((value) => {
        const normalizedValue = normalizeLowercaseStringOrEmpty(value);
        return normalizedId === normalizedValue || normalizedId.startsWith(normalizedValue);
    });
}
export function cloneFirstTemplateModel(params) {
    const trimmedModelId = params.modelId.trim();
    for (const templateId of [...new Set(params.templateIds)].filter(Boolean)) {
        const template = params.ctx.modelRegistry.find(params.providerId, templateId);
        if (!template) {
            continue;
        }
        return normalizeModelCompat({
            ...template,
            id: trimmedModelId,
            name: trimmedModelId,
            ...params.patch,
        });
    }
    return undefined;
}
