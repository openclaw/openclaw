export function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  return normalizeNullableString(value) ?? undefined;
}

export function hasNonEmptyString(value: unknown): value is string {
  return normalizeOptionalString(value) !== undefined;
}

/**
 * Sanitize a display name for use as the `name` field in model provider
 * chat completion messages.  OpenAI and compatible APIs restrict this
 * field to {@link https://platform.openai.com/docs/api-reference/chat/create /^[a-zA-Z0-9_-]{1,64}$/}.
 *
 * Characters outside the allowed set are replaced with `_` and the
 * result is truncated to 64 characters.  Returns `undefined` when the
 * input is empty or produces an empty sanitized string.
 */
export function sanitizeModelName(value: unknown): string | undefined {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return undefined;
  }
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return sanitized || undefined;
}
