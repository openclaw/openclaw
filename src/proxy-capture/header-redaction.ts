// Fetch capture and the standalone proxy share one header-redaction policy.
import { isHeadersLike, type HeadersLike } from "../infra/fetch-headers.js";
import { redactRegisteredSecretValues } from "../logging/secret-redaction-registry.js";
import { isLikelySensitiveModelProviderHeaderName } from "../secrets/model-provider-header-policy.js";

export const REDACTED_CAPTURE_HEADER_VALUE = "[REDACTED]";

function isSensitiveCaptureHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    isLikelySensitiveModelProviderHeaderName(normalized) ||
    normalized === "cookie" ||
    normalized === "set-cookie" ||
    normalized.includes("session")
  );
}

export function redactedCaptureHeaders(
  headers: HeadersLike | Record<string, string | string[] | undefined> | undefined,
  additionalSensitiveNames?: Iterable<string>,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const additionalSensitive = new Set(
    [...(additionalSensitiveNames ?? [])].map((name) => name.trim().toLowerCase()),
  );
  const entries = isHeadersLike(headers) ? Array.from(headers.entries()) : Object.entries(headers);
  const redacted: Record<string, string> = {};
  for (const [name, value] of entries) {
    // Innocuous names still need value redaction for registered secrets.
    if (additionalSensitive.has(name.trim().toLowerCase()) || isSensitiveCaptureHeaderName(name)) {
      redacted[name] = REDACTED_CAPTURE_HEADER_VALUE;
      continue;
    }
    const flattened = Array.isArray(value) ? value.join(", ") : (value ?? "");
    redacted[name] = redactRegisteredSecretValues(flattened, () => REDACTED_CAPTURE_HEADER_VALUE);
  }
  return redacted;
}
