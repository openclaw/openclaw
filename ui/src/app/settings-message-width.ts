// Browser-local transcript-width validation, shared by settings reads and writes.
const CSS_WIDTH_LITERAL_RE =
  /^(?:none|min-content|max-content|(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|ch|vw|vh|vmin|vmax|%))$/i;
const CSS_WIDTH_ALLOWED_IDENTIFIER_RE =
  /^(?:none|min-content|max-content|calc|clamp|fit-content|max|min|ch|em|rem|vh|vmax|vmin|vw|px)$/i;
const CSS_WIDTH_ALLOWED_CHARS = /^[0-9A-Za-z.%+\-*/(),\s]+$/;
const CSS_WIDTH_IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9-]*/g;
const CSS_WIDTH_MAX_LENGTH = 96;

function hasAllowedWidthIdentifiers(value: string): boolean {
  return (value.match(CSS_WIDTH_IDENTIFIER_RE) ?? []).every((identifier) =>
    CSS_WIDTH_ALLOWED_IDENTIFIER_RE.test(identifier),
  );
}

export function normalizeChatMessageMaxWidth(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > CSS_WIDTH_MAX_LENGTH) {
    return undefined;
  }
  if (CSS_WIDTH_LITERAL_RE.test(normalized)) {
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
