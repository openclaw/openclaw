import { DEFAULT_SECRET_PROVIDER_ALIAS, } from "../config/types.secrets.js";
const FILE_SECRET_REF_SEGMENT_PATTERN = /^(?:[^~]|~0|~1)*$/;
export const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export const SINGLE_VALUE_FILE_REF_ID = "value";
export const FILE_SECRET_REF_ID_PATTERN = /^(?:value|\/(?:[^~]|~0|~1)*(?:\/(?:[^~]|~0|~1)*)*)$/;
export const EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN = "^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$";
export function secretRefKey(ref) {
    return `${ref.source}:${ref.provider}:${ref.id}`;
}
export function resolveDefaultSecretProviderAlias(config, source, options) {
    const configured = source === "env"
        ? config.secrets?.defaults?.env
        : source === "file"
            ? config.secrets?.defaults?.file
            : config.secrets?.defaults?.exec;
    if (configured?.trim()) {
        return configured.trim();
    }
    if (options?.preferFirstProviderForSource) {
        const providers = config.secrets?.providers;
        if (providers) {
            for (const [providerName, provider] of Object.entries(providers)) {
                if (provider?.source === source) {
                    return providerName;
                }
            }
        }
    }
    return DEFAULT_SECRET_PROVIDER_ALIAS;
}
export function isValidFileSecretRefId(value) {
    if (value === SINGLE_VALUE_FILE_REF_ID) {
        return true;
    }
    if (!value.startsWith("/")) {
        return false;
    }
    return value
        .slice(1)
        .split("/")
        .every((segment) => FILE_SECRET_REF_SEGMENT_PATTERN.test(segment));
}
export function isValidSecretProviderAlias(value) {
    return SECRET_PROVIDER_ALIAS_PATTERN.test(value);
}
export function validateExecSecretRefId(value) {
    if (!EXEC_SECRET_REF_ID_PATTERN.test(value)) {
        return { ok: false, reason: "pattern" };
    }
    for (const segment of value.split("/")) {
        if (segment === "." || segment === "..") {
            return { ok: false, reason: "traversal-segment" };
        }
    }
    return { ok: true };
}
export function isValidExecSecretRefId(value) {
    return validateExecSecretRefId(value).ok;
}
export function formatExecSecretRefIdValidationMessage() {
    return [
        "Exec secret reference id must match /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/",
        'and must not include "." or ".." path segments',
        '(example: "vault/openai/api-key").',
    ].join(" ");
}
