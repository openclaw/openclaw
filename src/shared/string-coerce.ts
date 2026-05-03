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

export function normalizeStringifiedOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return normalizeOptionalString(String(value));
  }
  return undefined;
}

export function normalizeOptionalLowercaseString(value: unknown): string | undefined {
  return normalizeOptionalString(value)?.toLowerCase();
}

export function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

export function normalizeFastMode(raw?: string | boolean | null): boolean | undefined {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  if (["off", "false", "no", "0", "disable", "disabled", "normal"].includes(key)) {
    return false;
  }
  if (["on", "true", "yes", "1", "enable", "enabled", "fast"].includes(key)) {
    return true;
  }
  return undefined;
}

export function lowercasePreservingWhitespace(value: string): string {
  return value.toLowerCase();
}

export function localeLowercasePreservingWhitespace(value: string): string {
  return value.toLocaleLowerCase();
}

export function resolvePrimaryStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return normalizeOptionalString((value as { primary?: unknown }).primary);
}

export function normalizeOptionalThreadValue(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }
  return normalizeOptionalString(value);
}

export function normalizeOptionalStringifiedId(value: unknown): string | undefined {
  const normalized = normalizeOptionalThreadValue(value);
  return normalized == null ? undefined : String(normalized);
}

export function hasNonEmptyString(value: unknown): value is string {
  return normalizeOptionalString(value) !== undefined;
}

/**
 * Sanitize a sender display name for use as the `name` field in model API
 * messages. The OpenAI API (and compatible providers) restrict this field to
 * characters matching `[a-zA-Z0-9_-]` with a maximum length of 64 characters.
 *
 * Telegram (and other channel) display names routinely contain spaces, accents,
 * CJK characters, and emoji which cause a 400 rejection when sent unsanitized.
 *
 * Returns `undefined` when the result would be empty after sanitization so the
 * caller can omit the field entirely.
 */
export function sanitizeSenderNameForModel(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  // Collapse consecutive underscores and trim leading/trailing underscores
  const collapsed = sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return collapsed || undefined;
}
