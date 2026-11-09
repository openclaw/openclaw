import { coerceErrorMessage as normalizeErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Gateway pairing RPCs answer an id they do not know with INVALID_REQUEST "unknown <field>". */
export function isUnknownRequestIdError(
  error: unknown,
  field: "requestId" | "deviceId" = "requestId",
): boolean {
  const gatewayError = typeof error === "object" && error !== null ? error : undefined;
  const gatewayCode =
    gatewayError && "gatewayCode" in gatewayError ? gatewayError.gatewayCode : undefined;
  if (gatewayCode !== undefined && gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  const rawMessage = gatewayError && "message" in gatewayError ? gatewayError.message : undefined;
  const message = typeof rawMessage === "string" ? rawMessage : normalizeErrorMessage(error);
  return normalizeLowercaseStringOrEmpty(message).includes(`unknown ${field.toLowerCase()}`);
}
