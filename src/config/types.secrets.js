export const DEFAULT_SECRET_PROVIDER_ALIAS = "default";
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isSecretRef(value) {
    if (!isRecord(value)) {
        return false;
    }
    if (Object.keys(value).length !== 3) {
        return false;
    }
    return ((value.source === "env" || value.source === "file" || value.source === "exec") &&
        typeof value.provider === "string" &&
        value.provider.trim().length > 0 &&
        typeof value.id === "string" &&
        value.id.trim().length > 0);
}
function isLegacySecretRefWithoutProvider(value) {
    if (!isRecord(value)) {
        return false;
    }
    return ((value.source === "env" || value.source === "file" || value.source === "exec") &&
        typeof value.id === "string" &&
        value.id.trim().length > 0 &&
        value.provider === undefined);
}
export function parseEnvTemplateSecretRef(value, provider = DEFAULT_SECRET_PROVIDER_ALIAS) {
    if (typeof value !== "string") {
        return null;
    }
    const match = ENV_SECRET_TEMPLATE_RE.exec(value.trim());
    if (!match) {
        return null;
    }
    return {
        source: "env",
        provider: provider.trim() || DEFAULT_SECRET_PROVIDER_ALIAS,
        id: match[1],
    };
}
export function coerceSecretRef(value, defaults) {
    if (isSecretRef(value)) {
        return value;
    }
    if (isLegacySecretRefWithoutProvider(value)) {
        const provider = value.source === "env"
            ? (defaults?.env ?? DEFAULT_SECRET_PROVIDER_ALIAS)
            : value.source === "file"
                ? (defaults?.file ?? DEFAULT_SECRET_PROVIDER_ALIAS)
                : (defaults?.exec ?? DEFAULT_SECRET_PROVIDER_ALIAS);
        return {
            source: value.source,
            provider,
            id: value.id,
        };
    }
    const envTemplate = parseEnvTemplateSecretRef(value, defaults?.env);
    if (envTemplate) {
        return envTemplate;
    }
    return null;
}
