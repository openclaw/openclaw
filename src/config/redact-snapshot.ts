import type { ConfigFileSnapshot } from "./types.openclaw.js";
import { isSensitivePath, type ConfigUiHints } from "./schema.js";

/**
 * Sentinel value used to replace sensitive config fields in gateway responses.
 * Write-side handlers (config.set, config.apply, config.patch) detect this
 * sentinel and restore the original value from the on-disk config, so a
 * round-trip through the Web UI does not corrupt credentials.
 */
export const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

/**
 * Determine whether a dot-path points to a sensitive field.
 *
 * Resolution order:
 * 1. Direct uiHints lookup (e.g. "channels.slack.botToken")
 * 2. Wildcard lookup — numeric path segments replaced with "*"
 * 3. Falls back to regex-based `isSensitivePath()` only when no hints are provided
 */
function lookupSensitive(dotPath: string, hints?: ConfigUiHints): boolean {
  if (!hints) {
    return isSensitivePath(dotPath);
  }

  const direct = hints[dotPath];
  if (direct?.sensitive !== undefined) {
    return direct.sensitive;
  }

  // Wildcard: replace numeric segments (array indices) with *
  const wildcard = dotPath.replace(/(?<=\.)(\d+)(?=\.|$)/g, "*");
  if (wildcard !== dotPath) {
    const wHint = hints[wildcard];
    if (wHint?.sensitive !== undefined) {
      return wHint.sensitive;
    }
  }

  return false;
}

/**
 * Deep-walk an object and replace string values at sensitive paths
 * with the redaction sentinel.
 */
function redactObject(obj: unknown, hints?: ConfigUiHints, prefix = ""): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item, i) => redactObject(item, hints, prefix ? `${prefix}.${i}` : `${i}`));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (
      lookupSensitive(dotPath, hints) &&
      typeof value === "string" &&
      !/^\$\{[^}]*\}$/.test(value.trim())
    ) {
      result[key] = REDACTED_SENTINEL;
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactObject(value, hints, dotPath);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Collect all sensitive string values from a config object.
 * Used for text-based redaction of the raw JSON5 source.
 */
function collectSensitiveValues(obj: unknown, hints?: ConfigUiHints, prefix = ""): string[] {
  const values: string[] = [];
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return values;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      values.push(...collectSensitiveValues(obj[i], hints, prefix ? `${prefix}.${i}` : `${i}`));
    }
    return values;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (lookupSensitive(dotPath, hints) && typeof value === "string" && value.length > 0) {
      values.push(value);
    } else if (typeof value === "object" && value !== null) {
      values.push(...collectSensitiveValues(value, hints, dotPath));
    }
  }
  return values;
}

/**
 * Replace known sensitive values in a raw JSON5 string with the sentinel.
 * Values are replaced longest-first to avoid partial matches.
 */
function redactRawText(raw: string, config: unknown, hints?: ConfigUiHints): string {
  const sensitiveValues = collectSensitiveValues(config, hints);
  sensitiveValues.sort((a, b) => b.length - a.length);
  let result = raw;
  for (const value of sensitiveValues) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), REDACTED_SENTINEL);
  }
  return result;
}

/**
 * Returns a copy of the config snapshot with all sensitive fields
 * replaced by {@link REDACTED_SENTINEL}. The `hash` is preserved
 * (it tracks config identity, not content).
 *
 * Both `config` (the parsed object) and `raw` (the JSON5 source) are scrubbed
 * so no credential can leak through either path.
 *
 * When `uiHints` are provided, sensitivity is determined from the schema hints.
 * Without hints, falls back to regex-based detection via `isSensitivePath()`.
 */
/**
 * Redact sensitive fields from a plain config object (not a full snapshot).
 * Used by write endpoints (config.set, config.patch, config.apply) to avoid
 * leaking credentials in their responses.
 */
export function redactConfigObject<T>(value: T, uiHints?: ConfigUiHints): T {
  return redactObject(value, uiHints) as T;
}

export function redactConfigSnapshot(
  snapshot: ConfigFileSnapshot,
  uiHints?: ConfigUiHints,
): ConfigFileSnapshot {
  const redactedConfig = redactObject(snapshot.config, uiHints) as ConfigFileSnapshot["config"];
  const redactedRaw = snapshot.raw ? redactRawText(snapshot.raw, snapshot.config, uiHints) : null;
  const redactedParsed = snapshot.parsed ? redactObject(snapshot.parsed, uiHints) : snapshot.parsed;

  return {
    ...snapshot,
    config: redactedConfig,
    raw: redactedRaw,
    parsed: redactedParsed,
  };
}

/**
 * Deep-walk `incoming` and replace any {@link REDACTED_SENTINEL} values
 * (on sensitive paths) with the corresponding value from `original`.
 *
 * This is called by config.set / config.apply / config.patch before writing,
 * so that credentials survive a Web UI round-trip unmodified.
 */
export function restoreRedactedValues(
  incoming: unknown,
  original: unknown,
  uiHints?: ConfigUiHints,
  prefix = "",
): unknown {
  if (incoming === null || incoming === undefined) {
    return incoming;
  }
  if (typeof incoming !== "object") {
    return incoming;
  }
  if (Array.isArray(incoming)) {
    const origArr = Array.isArray(original) ? original : [];
    return incoming.map((item, i) =>
      restoreRedactedValues(item, origArr[i], uiHints, prefix ? `${prefix}.${i}` : `${i}`),
    );
  }
  const orig =
    original && typeof original === "object" && !Array.isArray(original)
      ? (original as Record<string, unknown>)
      : {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (
      lookupSensitive(dotPath, uiHints) &&
      value === REDACTED_SENTINEL &&
      typeof orig[key] === "string"
    ) {
      result[key] = orig[key];
    } else if (typeof value === "object" && value !== null) {
      result[key] = restoreRedactedValues(value, orig[key], uiHints, dotPath);
    } else {
      result[key] = value;
    }
  }
  return result;
}
