import { DEFAULT_SECRET_PROVIDER_ALIAS, } from "../config/types.secrets.js";
const FILE_SECRET_REF_SEGMENT_PATTERN = /^(?:[^~]|~0|~1)*$/;
export const SINGLE_VALUE_FILE_REF_ID = "value";
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
