// Browser-local transcript-width validation, shared by settings reads and writes.
const CSS_WIDTH_KEYWORDS = new Set(["none", "min-content", "max-content"]);
const CSS_WIDTH_FUNCTIONS = new Set(["calc", "clamp", "fit-content", "max", "min"]);
const CSS_WIDTH_UNITS = new Set(["ch", "em", "rem", "vh", "vmax", "vmin", "vw", "px"]);
const CSS_WIDTH_ALLOWED_CHARS = /^[0-9A-Za-z.%+\-*/(),\s]+$/;
const CSS_WIDTH_IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9-]*/g;
const CSS_WIDTH_SIMPLE_RE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|ch|vw|vh|vmin|vmax|%)$/i;
const CSS_WIDTH_MAX_LENGTH = 96;

function hasAllowedWidthIdentifiers(value: string): boolean {
  for (const match of value.matchAll(CSS_WIDTH_IDENTIFIER_RE)) {
    const identifier = match[0].toLowerCase();
    if (
      !CSS_WIDTH_FUNCTIONS.has(identifier) &&
      !CSS_WIDTH_KEYWORDS.has(identifier) &&
      !CSS_WIDTH_UNITS.has(identifier)
    ) {
      return false;
    }
  }
  return true;
}

export function normalizeChatMessageMaxWidth(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length > CSS_WIDTH_MAX_LENGTH) {
    return undefined;
  }
  if (CSS_WIDTH_KEYWORDS.has(normalized.toLowerCase()) || CSS_WIDTH_SIMPLE_RE.test(normalized)) {
    return normalized;
  }
  if (
    !CSS_WIDTH_ALLOWED_CHARS.test(normalized) ||
    !CSS.supports("max-width", normalized) ||
    !hasAllowedWidthIdentifiers(normalized)
  ) {
    return undefined;
  }
  return /^(?:calc|clamp|fit-content|max|min)\(.+\)$/i.test(normalized) ? normalized : undefined;
}
