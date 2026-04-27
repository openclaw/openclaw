import { normalizeOptionalString } from "../shared/string-coerce.js";
export function parseGenerationModelRef(raw) {
    const trimmed = normalizeOptionalString(raw);
    if (!trimmed) {
        return null;
    }
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
        return null;
    }
    const provider = normalizeOptionalString(trimmed.slice(0, slashIndex));
    const model = normalizeOptionalString(trimmed.slice(slashIndex + 1));
    if (!provider || !model) {
        return null;
    }
    return { provider, model };
}
