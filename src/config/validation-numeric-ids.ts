import type { ConfigValidationIssue } from "./types.js";

/**
 * Scan the raw (pre-Zod) config for numeric values that exceed
 * Number.MAX_SAFE_INTEGER. These are almost always Discord/Slack/Telegram
 * snowflake IDs that lost precision during JSON.parse because they were
 * written without quotes.
 *
 * Example: `"users": [233734246190153728]` silently becomes
 *          `233734246190153730` after parsing.
 */
export function warnUnsafeNumericIds(raw: unknown): ConfigValidationIssue[] {
  const warnings: ConfigValidationIssue[] = [];
  walk(raw, "", warnings);
  return warnings;
}

function walk(value: unknown, path: string, out: ConfigValidationIssue[]): void {
  if (typeof value === "number" && !Number.isSafeInteger(value) && Number.isFinite(value)) {
    out.push({
      path: path || "(root)",
      message:
        `Numeric value ${value} exceeds Number.MAX_SAFE_INTEGER and lost precision during JSON parsing. ` +
        `Wrap it in quotes (e.g. "${value}") to preserve the exact value.`,
    });
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], path ? `${path}[${i}]` : `[${i}]`, out);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, out);
    }
  }
}
