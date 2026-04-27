import { normalizeOptionalString } from "../../shared/string-coerce.js";
export const ConnectErrorDetailCodes = {
    AUTH_REQUIRED: "AUTH_REQUIRED",
    AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
    AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
    AUTH_TOKEN_MISMATCH: "AUTH_TOKEN_MISMATCH",
    AUTH_TOKEN_NOT_CONFIGURED: "AUTH_TOKEN_NOT_CONFIGURED",
    AUTH_PASSWORD_MISSING: "AUTH_PASSWORD_MISSING", // pragma: allowlist secret
    AUTH_PASSWORD_MISMATCH: "AUTH_PASSWORD_MISMATCH", // pragma: allowlist secret
    AUTH_PASSWORD_NOT_CONFIGURED: "AUTH_PASSWORD_NOT_CONFIGURED", // pragma: allowlist secret
    AUTH_BOOTSTRAP_TOKEN_INVALID: "AUTH_BOOTSTRAP_TOKEN_INVALID",
    AUTH_DEVICE_TOKEN_MISMATCH: "AUTH_DEVICE_TOKEN_MISMATCH",
    AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED",
    AUTH_TAILSCALE_IDENTITY_MISSING: "AUTH_TAILSCALE_IDENTITY_MISSING",
    AUTH_TAILSCALE_PROXY_MISSING: "AUTH_TAILSCALE_PROXY_MISSING",
    AUTH_TAILSCALE_WHOIS_FAILED: "AUTH_TAILSCALE_WHOIS_FAILED",
    AUTH_TAILSCALE_IDENTITY_MISMATCH: "AUTH_TAILSCALE_IDENTITY_MISMATCH",
    CONTROL_UI_ORIGIN_NOT_ALLOWED: "CONTROL_UI_ORIGIN_NOT_ALLOWED",
    CONTROL_UI_DEVICE_IDENTITY_REQUIRED: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
    DEVICE_IDENTITY_REQUIRED: "DEVICE_IDENTITY_REQUIRED",
    DEVICE_AUTH_INVALID: "DEVICE_AUTH_INVALID",
    DEVICE_AUTH_DEVICE_ID_MISMATCH: "DEVICE_AUTH_DEVICE_ID_MISMATCH",
    DEVICE_AUTH_SIGNATURE_EXPIRED: "DEVICE_AUTH_SIGNATURE_EXPIRED",
    DEVICE_AUTH_NONCE_REQUIRED: "DEVICE_AUTH_NONCE_REQUIRED",
    DEVICE_AUTH_NONCE_MISMATCH: "DEVICE_AUTH_NONCE_MISMATCH",
    DEVICE_AUTH_SIGNATURE_INVALID: "DEVICE_AUTH_SIGNATURE_INVALID",
    DEVICE_AUTH_PUBLIC_KEY_INVALID: "DEVICE_AUTH_PUBLIC_KEY_INVALID",
    PAIRING_REQUIRED: "PAIRING_REQUIRED",
};
export const ConnectPairingRequiredReasons = {
    NOT_PAIRED: "not-paired",
    ROLE_UPGRADE: "role-upgrade",
    SCOPE_UPGRADE: "scope-upgrade",
    METADATA_UPGRADE: "metadata-upgrade",
};
const CONNECT_RECOVERY_NEXT_STEP_VALUES = new Set([
    "retry_with_device_token",
    "update_auth_configuration",
    "update_auth_credentials",
    "wait_then_retry",
    "review_auth_configuration",
]);
const CONNECT_PAIRING_REQUIRED_REASON_VALUES = new Set([
    "not-paired",
    "role-upgrade",
    "scope-upgrade",
    "metadata-upgrade",
]);
const PAIRING_CONNECT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PAIRING_CONNECT_REASON_METADATA = {
    "not-paired": {
        requirement: "device is not approved yet",
        remediationHint: "Approve this device from the pending pairing requests.",
        recoveryTitle: "Gateway pairing approval required.",
    },
    "role-upgrade": {
        requirement: "device is asking for a higher role than currently approved",
        remediationHint: "Review the requested role upgrade, then approve the pending request.",
        recoveryTitle: "Gateway role upgrade approval required.",
    },
    "scope-upgrade": {
        requirement: "device is asking for more scopes than currently approved",
        remediationHint: "Review the requested scopes, then approve the pending upgrade.",
        recoveryTitle: "Gateway scope upgrade approval required.",
    },
    "metadata-upgrade": {
        requirement: "device identity changed and must be re-approved",
        remediationHint: "Review the refreshed device details, then approve the pending request.",
        recoveryTitle: "Gateway device refresh approval required.",
    },
};
const CONNECT_PAIRING_REQUIRED_MESSAGE_BY_REASON = {
    "not-paired": "device pairing required",
    "role-upgrade": "role upgrade pending approval",
    "scope-upgrade": "scope upgrade pending approval",
    "metadata-upgrade": "device metadata change pending approval",
};
export function resolveAuthConnectErrorDetailCode(reason) {
    switch (reason) {
        case "token_missing":
            return ConnectErrorDetailCodes.AUTH_TOKEN_MISSING;
        case "token_mismatch":
            return ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH;
        case "token_missing_config":
            return ConnectErrorDetailCodes.AUTH_TOKEN_NOT_CONFIGURED;
        case "password_missing":
            return ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING;
        case "password_mismatch":
            return ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH;
        case "password_missing_config":
            return ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED;
        case "bootstrap_token_invalid":
            return ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID;
        case "tailscale_user_missing":
            return ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISSING;
        case "tailscale_proxy_missing":
            return ConnectErrorDetailCodes.AUTH_TAILSCALE_PROXY_MISSING;
        case "tailscale_whois_failed":
            return ConnectErrorDetailCodes.AUTH_TAILSCALE_WHOIS_FAILED;
        case "tailscale_user_mismatch":
            return ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISMATCH;
        case "rate_limited":
            return ConnectErrorDetailCodes.AUTH_RATE_LIMITED;
        case "device_token_mismatch":
            return ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH;
        case undefined:
            return ConnectErrorDetailCodes.AUTH_REQUIRED;
        default:
            return ConnectErrorDetailCodes.AUTH_UNAUTHORIZED;
    }
}
export function resolveDeviceAuthConnectErrorDetailCode(reason) {
    switch (reason) {
        case "device-id-mismatch":
            return ConnectErrorDetailCodes.DEVICE_AUTH_DEVICE_ID_MISMATCH;
        case "device-signature-stale":
            return ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_EXPIRED;
        case "device-nonce-missing":
            return ConnectErrorDetailCodes.DEVICE_AUTH_NONCE_REQUIRED;
        case "device-nonce-mismatch":
            return ConnectErrorDetailCodes.DEVICE_AUTH_NONCE_MISMATCH;
        case "device-signature":
            return ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_INVALID;
        case "device-public-key":
            return ConnectErrorDetailCodes.DEVICE_AUTH_PUBLIC_KEY_INVALID;
        default:
            return ConnectErrorDetailCodes.DEVICE_AUTH_INVALID;
    }
}
export function readConnectErrorDetailCode(details) {
    if (!details || typeof details !== "object" || Array.isArray(details)) {
        return null;
    }
    const code = details.code;
    return typeof code === "string" && code.trim().length > 0 ? code : null;
}
export function readConnectErrorRecoveryAdvice(details) {
    if (!details || typeof details !== "object" || Array.isArray(details)) {
        return {};
    }
    const raw = details;
    const canRetryWithDeviceToken = typeof raw.canRetryWithDeviceToken === "boolean" ? raw.canRetryWithDeviceToken : undefined;
    const normalizedNextStep = normalizeOptionalString(raw.recommendedNextStep) ?? "";
    const recommendedNextStep = CONNECT_RECOVERY_NEXT_STEP_VALUES.has(normalizedNextStep)
        ? normalizedNextStep
        : undefined;
    return {
        canRetryWithDeviceToken,
        recommendedNextStep,
    };
}
function normalizePairingConnectReason(value) {
    const normalized = normalizeOptionalString(value) ?? "";
    return CONNECT_PAIRING_REQUIRED_REASON_VALUES.has(normalized)
        ? normalized
        : undefined;
}
export function normalizePairingConnectRequestId(value) {
    const normalized = normalizeOptionalString(value);
    return normalized && PAIRING_CONNECT_REQUEST_ID_PATTERN.test(normalized) ? normalized : undefined;
}
function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const normalized = value
        .map((item) => normalizeOptionalString(item))
        .filter((item) => Boolean(item));
    return normalized.length > 0 ? normalized : [];
}
function createPairingConnectErrorDetails(params) {
    return {
        code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.requestId ? { requestId: params.requestId } : {}),
        ...(params.remediationHint ? { remediationHint: params.remediationHint } : {}),
        ...(params.deviceId ? { deviceId: params.deviceId } : {}),
        ...(params.requestedRole ? { requestedRole: params.requestedRole } : {}),
        ...(params.requestedScopes ? { requestedScopes: params.requestedScopes } : {}),
        ...(params.approvedRoles ? { approvedRoles: params.approvedRoles } : {}),
        ...(params.approvedScopes ? { approvedScopes: params.approvedScopes } : {}),
    };
}
export function describePairingConnectRequirement(reason) {
    return reason
        ? PAIRING_CONNECT_REASON_METADATA[reason].requirement
        : "device approval is required";
}
export function buildPairingConnectErrorMessage(reason) {
    return reason
        ? `pairing required: ${describePairingConnectRequirement(reason)}`
        : "pairing required";
}
export function buildPairingConnectRemediationHint(reason) {
    return reason
        ? PAIRING_CONNECT_REASON_METADATA[reason].remediationHint
        : "Approve the pending device request before retrying.";
}
export function buildPairingConnectRecoveryTitle(reason) {
    return reason
        ? PAIRING_CONNECT_REASON_METADATA[reason].recoveryTitle
        : "Gateway pairing approval required.";
}
export function buildPairingConnectErrorDetails(params) {
    const requestId = normalizePairingConnectRequestId(params.requestId);
    const remediationHint = normalizeOptionalString(params.remediationHint) ??
        buildPairingConnectRemediationHint(params.reason);
    const deviceId = normalizeOptionalString(params.deviceId);
    const requestedRole = normalizeOptionalString(params.requestedRole);
    const requestedScopes = normalizeStringArray(params.requestedScopes);
    const approvedRoles = normalizeStringArray(params.approvedRoles);
    const approvedScopes = normalizeStringArray(params.approvedScopes);
    return createPairingConnectErrorDetails({
        reason: params.reason,
        requestId,
        remediationHint,
        deviceId,
        requestedRole,
        requestedScopes,
        approvedRoles,
        approvedScopes,
    });
}
export function buildPairingConnectCloseReason(params) {
    const requestId = normalizePairingConnectRequestId(params.requestId);
    const message = buildPairingConnectErrorMessage(params.reason);
    return requestId ? `${message} (requestId: ${requestId})` : message;
}
export function readPairingConnectErrorDetails(details) {
    if (readConnectErrorDetailCode(details) !== ConnectErrorDetailCodes.PAIRING_REQUIRED) {
        return null;
    }
    if (!details || typeof details !== "object" || Array.isArray(details)) {
        return null;
    }
    const raw = details;
    const reason = normalizePairingConnectReason(raw.reason);
    const requestId = normalizePairingConnectRequestId(raw.requestId);
    const remediationHint = normalizeOptionalString(raw.remediationHint) ?? buildPairingConnectRemediationHint(reason);
    const deviceId = normalizeOptionalString(raw.deviceId);
    const requestedRole = normalizeOptionalString(raw.requestedRole);
    const requestedScopes = normalizeStringArray(raw.requestedScopes);
    const approvedRoles = normalizeStringArray(raw.approvedRoles);
    const approvedScopes = normalizeStringArray(raw.approvedScopes);
    return createPairingConnectErrorDetails({
        reason,
        requestId,
        remediationHint,
        deviceId,
        requestedRole,
        requestedScopes,
        approvedRoles,
        approvedScopes,
    });
}
export function readConnectPairingRequiredDetails(details) {
    const pairing = readPairingConnectErrorDetails(details);
    if (!pairing) {
        return null;
    }
    return {
        ...(pairing.requestId ? { requestId: pairing.requestId } : {}),
        ...(pairing.reason ? { reason: pairing.reason } : {}),
    };
}
export function readConnectPairingRequiredMessage(message) {
    const normalizedMessage = normalizeOptionalString(message);
    if (!normalizedMessage) {
        return null;
    }
    const normalized = normalizedMessage.trim().toLowerCase();
    let reason;
    for (const [candidate, prefix] of Object.entries(CONNECT_PAIRING_REQUIRED_MESSAGE_BY_REASON)) {
        if (normalized.includes(prefix)) {
            reason = candidate;
            break;
        }
    }
    if (!reason && normalized.includes("pairing required")) {
        reason = ConnectPairingRequiredReasons.NOT_PAIRED;
    }
    if (!reason) {
        return null;
    }
    const requestId = normalizePairingConnectRequestId(normalizedMessage.match(/\(requestId:\s*([^\s)]+)\)/i)?.[1]);
    return {
        ...(requestId ? { requestId } : {}),
        reason,
    };
}
export function formatConnectPairingRequiredMessage(details) {
    const pairing = readPairingConnectErrorDetails(details);
    const base = CONNECT_PAIRING_REQUIRED_MESSAGE_BY_REASON[pairing?.reason ?? ConnectPairingRequiredReasons.NOT_PAIRED];
    return pairing?.requestId ? `${base} (requestId: ${pairing.requestId})` : base;
}
export function formatConnectErrorMessage(params) {
    if (readConnectErrorDetailCode(params.details) === ConnectErrorDetailCodes.PAIRING_REQUIRED) {
        return formatConnectPairingRequiredMessage(params.details);
    }
    return normalizeOptionalString(params.message) ?? "gateway request failed";
}
