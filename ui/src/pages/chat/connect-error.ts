import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  ConnectErrorDetailCodes,
  describePairingConnectRequirement,
  formatConnectPairingRequiredMessage,
  readConnectPairingRequiredMessage,
  readPairingConnectErrorDetails,
} from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { resolveGatewayErrorDetailCode } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";

type ErrorWithMessageAndDetails = {
  message?: unknown;
  details?: unknown;
};

function normalizeErrorMessage(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof Error && typeof message.message === "string") {
    return message.message;
  }
  return "unknown error";
}

function formatPairingRequiredError(error: ErrorWithMessageAndDetails): string {
  const message = normalizeErrorMessage(error.message);
  const normalizedMessage = normalizeLowercaseStringOrEmpty(message);
  const pairing = readPairingConnectErrorDetails(error.details);
  const pairingMessage = readConnectPairingRequiredMessage(message);
  const pairingReason = pairing?.reason ?? pairingMessage?.reason;
  if (normalizedMessage.startsWith("pairing required:") && pairingReason) {
    return `gateway pairing required: ${describePairingConnectRequirement(pairingReason)}`;
  }
  if (pairingMessage && normalizedMessage !== "pairing required") {
    return message;
  }

  switch (pairing?.reason) {
    case "scope-upgrade":
    case "role-upgrade": {
      const kind = pairing.reason === "scope-upgrade" ? "scope" : "role";
      const approved = kind === "scope" ? pairing.approvedScopes : pairing.approvedRoles;
      const requested = kind === "scope" ? pairing.requestedScopes : pairing.requestedRole;
      if (!approved && !requested) {
        return formatConnectPairingRequiredMessage(error.details);
      }
      const approvedText = approved?.join(", ") ?? "none";
      const requestedText = Array.isArray(requested) ? requested.join(", ") : (requested ?? "none");
      return `device ${kind} upgrade requires approval (approved: ${approvedText}; requested: ${requestedText})`;
    }
    case "metadata-upgrade":
      return "device reconnect details changed and require approval";
    default:
      return "gateway pairing required";
  }
}

function formatErrorFromMessageAndDetails(error: ErrorWithMessageAndDetails): string {
  const message = normalizeErrorMessage(error.message);
  const detailCode = resolveGatewayErrorDetailCode(error);

  switch (detailCode) {
    case ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH:
      return "gateway token mismatch";
    case ConnectErrorDetailCodes.AUTH_UNAUTHORIZED:
      return "gateway auth failed";
    case ConnectErrorDetailCodes.AUTH_RATE_LIMITED:
      return "too many failed authentication attempts";
    case ConnectErrorDetailCodes.PAIRING_REQUIRED:
      return formatPairingRequiredError(error);
    case ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED:
      return "device identity required (use HTTPS or localhost)";
    case ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED:
      return "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)";
    case ConnectErrorDetailCodes.AUTH_TOKEN_MISSING:
      return "gateway token missing";
    default:
      break;
  }

  const normalized = normalizeLowercaseStringOrEmpty(message);
  return ["fetch failed", "failed to fetch", "connect failed"].includes(normalized)
    ? "gateway connect failed"
    : message;
}

export function formatConnectError(error: unknown): string {
  const message =
    error && typeof error === "object"
      ? formatErrorFromMessageAndDetails(error as ErrorWithMessageAndDetails)
      : normalizeErrorMessage(error);
  return formatUiError(message);
}
