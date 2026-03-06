function isAllowedWebhookProtocol(protocol: string) {
  return protocol === "http:" || protocol === "https:";
}

export type WebhookUrlResult = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Validate and normalize a webhook destination URL.
 * Returns a result object with an explicit rejection reason when invalid,
 * so callers can produce actionable log messages (#36551).
 */
export function validateHttpWebhookUrl(value: unknown): WebhookUrlResult {
  if (typeof value !== "string") {
    return { ok: false, reason: `expected string, got ${typeof value}` };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty URL" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: `malformed URL: "${trimmed}"` };
  }
  if (!isAllowedWebhookProtocol(parsed.protocol)) {
    return {
      ok: false,
      reason: `blocked scheme "${parsed.protocol}" (only http: and https: allowed)`,
    };
  }
  return { ok: true, url: trimmed };
}

/** @deprecated Use validateHttpWebhookUrl for explicit rejection reasons. */
export function normalizeHttpWebhookUrl(value: unknown): string | null {
  const result = validateHttpWebhookUrl(value);
  return result.ok ? result.url : null;
}
