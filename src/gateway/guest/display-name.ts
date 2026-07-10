const MAX_DISPLAY_NAME_CODE_POINTS = 64;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const HTML_RISK = /[&<>"']/u;
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{Letter}/u;

export function normalizeGuestDisplayName(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ");
  if (
    !normalized ||
    [...normalized].length > MAX_DISPLAY_NAME_CODE_POINTS ||
    CONTROL_OR_FORMAT.test(normalized) ||
    HTML_RISK.test(normalized) ||
    NON_LATIN_LETTER.test(normalized)
  ) {
    throw new Error("invalid guest display name");
  }
  return normalized;
}
