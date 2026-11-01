import { coerceErrorMessage as normalizeErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Gateway pairing RPCs answer an id they do not know with INVALID_REQUEST "unknown <field>". */
export function isUnknownRequestIdError(
  error: unknown,
  field: "requestId" | "deviceId" = "requestId",
): boolean {
  const maybeGatewayError =
    typeof error === "object" && error !== null
      ? // SAFETY: non-null object; both fields are re-checked with typeof/!== before use.
        (error as { gatewayCode?: unknown; message?: unknown })
      : undefined;
  const gatewayCode = maybeGatewayError?.gatewayCode;
  if (gatewayCode !== undefined && gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  const message =
    typeof maybeGatewayError?.message === "string"
      ? maybeGatewayError.message
      : normalizeErrorMessage(error);
  return normalizeLowercaseStringOrEmpty(message).includes(`unknown ${field.toLowerCase()}`);
}
