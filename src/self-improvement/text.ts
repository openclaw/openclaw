import { redactSensitiveText } from "../logging/redact.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

function redactLocalPaths(value: string): string {
  return value
    .replace(/(["'])\/Users\/(?:(?!\1).)*\1/g, "$1[local-path]$1")
    .replace(/(["'])\/home\/(?:(?!\1).)*\1/g, "$1[local-path]$1")
    .replace(/(["'])\/private\/(?:(?!\1).)*\1/g, "$1[local-path]$1")
    .replace(/(["'])\/tmp\/(?:(?!\1).)*\1/g, "$1[local-path]$1")
    .replace(/(["'])\/var\/folders\/(?:(?!\1).)*\1/g, "$1[local-path]$1")
    .replace(/(["'])\/var\/tmp\/(?:(?!\1).)*\1/g, "$1[local-path]$1")
    .replace(/(["'])\/opt\/homebrew\/(?:(?!\1).)*\1/g, "$1[local-path]$1")
    .replace(/(["'])\/usr\/local\/(?:(?!\1).)*\1/g, "$1[local-path]$1")
    .replace(/\/Users\/[^\s"'`<>]+/g, "[local-path]")
    .replace(/\/home\/[^\s"'`<>]+/g, "[local-path]")
    .replace(/\/private\/[^\s"'`<>]+/g, "[local-path]")
    .replace(/\/tmp\/[^\s"'`<>]+/g, "[local-path]")
    .replace(/\/var\/folders\/[^\s"'`<>]+/g, "[local-path]")
    .replace(/\/var\/tmp\/[^\s"'`<>]+/g, "[local-path]")
    .replace(/\/opt\/homebrew\/[^\s"'`<>]+/g, "[local-path]")
    .replace(/\/usr\/local\/[^\s"'`<>]+/g, "[local-path]")
    .replace(/~\/[^\s"'`<>]+/g, "[local-path]")
    .replace(/\b[A-Za-z]:\\Users\\[^\s"'`<>]+/g, "[local-path]");
}

export function sanitizeRecommendationText(value: unknown, maxChars = 600): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return "";
  }
  const singleLine = normalized.replace(/\s+/g, " ").trim();
  const redacted = redactLocalPaths(redactSensitiveText(singleLine, { mode: "tools" }));
  if (redacted.length <= maxChars) {
    return redacted;
  }
  return `${redacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function sanitizeRecommendationTexts(values: readonly unknown[], maxChars = 240): string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const value of values) {
    const text = sanitizeRecommendationText(value, maxChars);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    sanitized.push(text);
  }
  return sanitized;
}
