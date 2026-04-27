import { hasConfiguredSecretInput, normalizeResolvedSecretInputString, normalizeSecretInputString, resolveSecretInputRef, } from "../../config/types.secrets.js";
export function hasConfiguredMemorySecretInput(value) {
    return hasConfiguredSecretInput(value);
}
export function resolveMemorySecretInputString(params) {
    const { ref } = resolveSecretInputRef({ value: params.value });
    if (ref?.source === "env") {
        const envValue = normalizeSecretInputString(process.env[ref.id]);
        if (envValue) {
            return envValue;
        }
    }
    return normalizeResolvedSecretInputString({
        value: params.value,
        path: params.path,
    });
}
