import { isRecord } from "../utils.js";
export const DEFAULT_SECRET_PROVIDER_ALIAS = "default"; // pragma: allowlist secret
export const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
export const LEGACY_SECRETREF_ENV_MARKER_PREFIX = "secretref-env:"; // pragma: allowlist secret
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
export function isValidEnvSecretRefId(value) {
    return ENV_SECRET_REF_ID_RE.test(value);
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
export function parseLegacySecretRefEnvMarker(value, provider = DEFAULT_SECRET_PROVIDER_ALIAS) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed.startsWith(LEGACY_SECRETREF_ENV_MARKER_PREFIX)) {
        return null;
    }
    const id = trimmed.slice(LEGACY_SECRETREF_ENV_MARKER_PREFIX.length);
    if (!ENV_SECRET_REF_ID_RE.test(id)) {
        return null;
    }
    return {
        source: "env",
        provider: provider.trim() || DEFAULT_SECRET_PROVIDER_ALIAS,
        id,
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
export function hasConfiguredSecretInput(value, defaults) {
    if (normalizeSecretInputString(value)) {
        return true;
    }
    return coerceSecretRef(value, defaults) !== null;
}
export function normalizeSecretInputString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function formatSecretRefLabel(ref) {
    return `${ref.source}:${ref.provider}:${ref.id}`;
}
function createUnresolvedSecretInputError(params) {
    return new Error(`${params.path}: unresolved SecretRef "${formatSecretRefLabel(params.ref)}". Resolve this command against an active gateway runtime snapshot before reading it.`);
}
export function assertSecretInputResolved(params) {
    const { ref } = resolveSecretInputRef({
        value: params.value,
        refValue: params.refValue,
        defaults: params.defaults,
    });
    if (!ref) {
        return;
    }
    throw createUnresolvedSecretInputError({ path: params.path, ref });
}
export function resolveSecretInputString(params) {
    const normalized = normalizeSecretInputString(params.value);
    if (normalized) {
        return {
            status: "available",
            value: normalized,
            ref: null,
        };
    }
    const { ref } = resolveSecretInputRef({
        value: params.value,
        refValue: params.refValue,
        defaults: params.defaults,
    });
    if (!ref) {
        return {
            status: "missing",
            value: undefined,
            ref: null,
        };
    }
    if ((params.mode ?? "strict") === "strict") {
        throw createUnresolvedSecretInputError({ path: params.path, ref });
    }
    return {
        status: "configured_unavailable",
        value: undefined,
        ref,
    };
}
export function normalizeResolvedSecretInputString(params) {
    const resolved = resolveSecretInputString({
        ...params,
        mode: "strict",
    });
    if (resolved.status === "available") {
        return resolved.value;
    }
    return undefined;
}
export function resolveSecretInputRef(params) {
    const explicitRef = coerceSecretRef(params.refValue, params.defaults);
    const inlineRef = explicitRef ? null : coerceSecretRef(params.value, params.defaults);
    return {
        explicitRef,
        inlineRef,
        ref: explicitRef ?? inlineRef,
    };
}
