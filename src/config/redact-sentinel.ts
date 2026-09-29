/** Display markers are never credential material. Match whole values, not substrings. */
export const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

const REDACTED_SECRET_VALUES = new Set([
  REDACTED_SENTINEL,
  "REDACTED",
  "xoxb-REDACTED",
  "xapp-REDACTED",
  "***",
  "[redacted]",
  "[REDACTED]",
  "<redacted>",
  "[REDACTED_PRIVATE_KEY]",
  "[REDACTED CREDENTIAL]",
]);

export function isRedactedSecretValue(value: unknown): boolean {
  return typeof value === "string" && REDACTED_SECRET_VALUES.has(value.trim());
}
