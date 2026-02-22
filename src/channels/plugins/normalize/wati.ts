/**
 * Normalize a raw string into a canonical `wati:<e164>` messaging target.
 *
 * Strips a "wati:" prefix if present, normalizes the remainder as an E.164
 * phone number, and returns `"wati:<normalized>"` or `undefined` if invalid.
 */
export function normalizeWatiMessagingTarget(raw: string): string | undefined {
  let trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^wati:/i.test(trimmed)) {
    trimmed = trimmed.slice("wati:".length).trim();
  }
  if (!trimmed) {
    return undefined;
  }
  // Strip spaces/dashes commonly found in phone numbers
  const cleaned = trimmed.replace(/[\s\-().]/g, "");
  // Must look like a phone number: optional + followed by digits (7+ chars)
  if (!/^\+?\d{7,}$/.test(cleaned)) {
    return undefined;
  }
  // Ensure + prefix for E.164
  const normalized = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  return `wati:${normalized}`;
}

/**
 * Returns true if the raw string looks like it could be a WATI target ID
 * (phone-number-based, similar to WhatsApp).
 */
export function looksLikeWatiTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^wati:/i.test(trimmed)) {
    return true;
  }
  // Phone number: + followed by digits, or just digits (7+ chars)
  return /^\+?\d{7,}$/.test(trimmed.replace(/[\s\-().]/g, ""));
}
