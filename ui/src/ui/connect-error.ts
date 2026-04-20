import {
  ConnectErrorDetailCodes,
  formatConnectPairingRequiredMessage,
} from "../../../src/gateway/protocol/connect-error-details.js";
import { resolveGatewayErrorDetailCode } from "./gateway.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

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
      return formatConnectPairingRequiredMessage(error.details);
    case ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED:
      return "device identity required (use HTTPS/localhost or allow insecure auth explicitly)";
    case ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED:
      return "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)";
    case ConnectErrorDetailCodes.AUTH_TOKEN_MISSING:
      return "gateway token missing";
    default:
      break;
  }

  const normalized = normalizeLowercaseStringOrEmpty(message);
  if (
    normalized === "fetch failed" ||
    normalized === "failed to fetch" ||
    normalized === "connect failed"
  ) {
    return "gateway connect failed";
  }
  return message;
}

export function formatConnectError(error: unknown): string {
  if (error && typeof error === "object") {
    return formatErrorFromMessageAndDetails(error as ErrorWithMessageAndDetails);
  }
  return normalizeErrorMessage(error);
}
