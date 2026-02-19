import { createSubsystemLogger } from "../logging/subsystem.js";
import { isSensitiveConfigPath, type ConfigUiHints } from "./schema.hints.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

const log = createSubsystemLogger("config/redaction");
const ENV_VAR_PLACEHOLDER_PATTERN = /^\$\{[^}]*\}$/;

function isSensitivePath(path: string): boolean {
  if (path.endsWith("[]")) {
    return isSensitiveConfigPath(path.slice(0, -2));
  } else {
    return isSensitiveConfigPath(path);
  }
}

function isEnvVarPlaceholder(value: string): boolean {
  return ENV_VAR_PLACEHOLDER_PATTERN.test(value.trim());
}

function isExtensionPath(path: string): boolean {
  return (
    path === "plugins" ||
    path.startsWith("plugins.") ||
    path === "channels" ||
    path.startsWith("channels.")
  );
}

function isExplicitlyNonSensitivePath(hints: ConfigUiHints | undefined, paths: string[]): boolean {
  if (!hints) {
    return false;
  }
  return paths.some((path) => hints[path]?.sensitive === false);
}

/**
 * Sentinel value used to replace sensitive config fields in gateway responses.
 * Write-side handlers (config.set, config.apply, config.patch) detect this
 * sentinel and restore the original value from the on-disk config, so a
 * round-trip through the Web UI does not corrupt credentials.
 */
export const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

// ConfigUiHints' keys look like this:
// - path.subpath.key (nested objects)
// - path.subpath[].key (object in array in object)
// - path.*.key (object in record in object)
// records are handled by the lookup, but arrays need two entries in
// the Set, as their first lookup is done before the code knows it's
// an array.
function buildRedactionLookup(hints: ConfigUiHints): Set<string> {
  let result = new Set<string>();

  for (const [path, hint] of Object.entries(hints)) {
    if (!hint.sensitive) {
      continue;
    }

    const parts = path.split(".");
    let joinedPath = parts.shift() ?? "";
    result.add(joinedPath);
    if (joinedPath.endsWith("[]")) {
      result.add(joinedPath.slice(0, -2));
    }

    for (const part of parts) {
      if (part.endsWith("[]")) {
        result.add(`${joinedPath}.${part.slice(0, -2)}`);
      }
      // hey, greptile, notice how this is *NOT* in an else block?
      joinedPath = `${joinedPath}.${part}`;
      result.add(joinedPath);
    }
  }
  if (result.size !== 0) {
    result.add("");
  }
  return result;
}

/**
 * Deep-walk an object and replace string values at sensitive paths
 * with the redaction sentinel.
 */
function redactObject(obj: unknown, hints?: ConfigUiHints): unknown {
  if (hints) {
    const lookup = buildRedactionLookup(hints);
    return lookup.has("")
      ? redactObjectWithLookup(obj, lookup, "", [], hints)
      : redactObjectGuessing(obj, "", [], hints);
  } else {
    return redactObjectGuessing(obj, "", []);
  }
}

/**
 * Collect all sensitive string values from a config object.
 * Used for text-based redaction of the raw JSON5 source.
 */
function collectSensitiveValues(obj: unknown, hints?: ConfigUiHints): string[] {
  const result: string[] = [];
  if (hints) {
    const lookup = buildRedactionLookup(hints);
    if (lookup.has("")) {
      redactObjectWithLookup(obj, lookup, "", result, hints);
    } else {
      redactObjectGuessing(obj, "", result, hints);
    }
  } else {
    redactObjectGuessing(obj, "", result);
  }
  return result;
}

/**
 * Worker for redactObject() and collectSensitiveValues().
 * Used when there are ConfigUiHints available.
 */
function redactObjectWithLookup(
  obj: unknown,
  lookup: Set<string>,
  prefix: string,
  values: string[],
  hints: ConfigUiHints,
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    const path = `${prefix}[]`;
    if (!lookup.has(path)) {
      if (!isExtensionPath(prefix)) {
        return obj;
      }
      return redactObjectGuessing(obj, prefix, values, hints);
    }
    return obj.map((item) => {
      if (typeof item === "string" && !isEnvVarPlaceholder(item)) {
        values.push(item);
        return REDACTED_SENTINEL;
      }
      return redactObjectWithLookup(item, lookup, path, values, hints);
    });
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const wildcardPath = prefix ? `${prefix}.*` : "*";
      let matched = false;
      for (const candidate of [path, wildcardPath]) {
        result[key] = value;
        if (lookup.has(candidate)) {
          matched = true;
          // Hey, greptile, look here, this **IS** only applied to strings
          if (typeof value === "string" && !isEnvVarPlaceholder(value)) {
            result[key] = REDACTED_SENTINEL;
            values.push(value);
          } else if (typeof value === "object" && value !== null) {
            result[key] = redactObjectWithLookup(value, lookup, candidate, values, hints);
          }
          break;
        }
      }
      if (!matched && isExtensionPath(path)) {
        const markedNonSensitive = isExplicitlyNonSensitivePath(hints, [path, wildcardPath]);
        if (
          typeof value === "string" &&
          !markedNonSensitive &&
          isSensitivePath(path) &&
          !isEnvVarPlaceholder(value)
        ) {
          result[key] = REDACTED_SENTINEL;
          values.push(value);
        } else if (typeof value === "object" && value !== null) {
          result[key] = redactObjectGuessing(value, path, values, hints);
        }
      }
    }
    return result;
  }

  return obj;
}

/**
 * Worker for redactObject() and collectSensitiveValues().
 * Used when ConfigUiHints are NOT available.
 */
function redactObjectGuessing(
  obj: unknown,
  prefix: string,
  values: string[],
  hints?: ConfigUiHints,
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => {
      const path = `${prefix}[]`;
      if (
        !isExplicitlyNonSensitivePath(hints, [path]) &&
        isSensitivePath(path) &&
        typeof item === "string" &&
        !isEnvVarPlaceholder(item)
      ) {
        values.push(item);
        return REDACTED_SENTINEL;
      }
      return redactObjectGuessing(item, path, values, hints);
    });
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const dotPath = prefix ? `${prefix}.${key}` : key;
      const wildcardPath = prefix ? `${prefix}.*` : "*";
      if (
        !isExplicitlyNonSensitivePath(hints, [dotPath, wildcardPath]) &&
        isSensitivePath(dotPath) &&
        typeof value === "string" &&
        !isEnvVarPlaceholder(value)
      ) {
        result[key] = REDACTED_SENTINEL;
        values.push(value);
      } else if (typeof value === "object" && value !== null) {
        result[key] = redactObjectGuessing(value, dotPath, values, hints);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return obj;
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
    result = result.replaceAll(value, REDACTED_SENTINEL);
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
  if (!snapshot.valid) {
    // This is bad. We could try to redact the raw string using known key names,
    // but then we would not be able to restore them, and would trash the user's
    // credentials. Less than ideal---we should never delete important data.
    // On the other hand, we cannot hand out "raw" if we're not sure we have
    // properly redacted all sensitive data. Handing out a partially or, worse,
    // unredacted config string would be bad.
    // Therefore, the only safe route is to reject handling out broken configs.
    return {
      ...snapshot,
      config: {},
      raw: null,
      parsed: null,
      resolved: {},
    };
  }
  // else: snapshot.config must be valid and populated, as that is what
  // readConfigFileSnapshot() does when it creates the snapshot.

  const redactedConfig = redactObject(snapshot.config, uiHints) as ConfigFileSnapshot["config"];
  const redactedRaw = snapshot.raw ? redactRawText(snapshot.raw, snapshot.config, uiHints) : null;
  const redactedParsed = snapshot.parsed ? redactObject(snapshot.parsed, uiHints) : snapshot.parsed;
  // Also redact the resolved config (contains values after ${ENV} substitution)
  const redactedResolved = redactConfigObject(snapshot.resolved, uiHints);

  return {
    ...snapshot,
    config: redactedConfig,
    raw: redactedRaw,
    parsed: redactedParsed,
    resolved: redactedResolved,
  };
}

export type RedactionResult = {
  ok: boolean;
  result?: unknown;
  error?: unknown;
  humanReadableMessage?: string;
};

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
  hints?: ConfigUiHints,
): RedactionResult {
  if (incoming === null || incoming === undefined) {
    return { ok: false, error: "no input" };
  }
  if (typeof incoming !== "object") {
    return { ok: false, error: "input not an object" };
  }
  try {
    if (hints) {
      const lookup = buildRedactionLookup(hints);
      if (lookup.has("")) {
        return {
          ok: true,
          result: restoreRedactedValuesWithLookup(incoming, original, lookup, "", hints),
        };
      } else {
        return { ok: true, result: restoreRedactedValuesGuessing(incoming, original, "", hints) };
      }
    } else {
      return { ok: true, result: restoreRedactedValuesGuessing(incoming, original, "") };
    }
  } catch (err) {
    if (err instanceof RedactionError) {
      return {
        ok: false,
        humanReadableMessage: `Sentinel value "${REDACTED_SENTINEL}" in key ${err.key} is not valid as real data`,
      };
    }
    throw err; // some coding error, pass through
  }
}

class RedactionError extends Error {
  public readonly key: string;

  constructor(key: string) {
    super("internal error class---should never escape");
    this.key = key;
    this.name = "RedactionError";
  }
}

function restoreOriginalValueOrThrow(params: {
  key: string;
  path: string;
  original: Record<string, unknown>;
}): unknown {
  if (params.key in params.original) {
    return params.original[params.key];
  }
  log.warn(`Cannot un-redact config key ${params.path} as it doesn't have any value`);
  throw new RedactionError(params.path);
}

function mapRedactedArray(params: {
  incoming: unknown[];
  original: unknown;
  path: string;
  mapItem: (item: unknown, index: number, originalArray: unknown[]) => unknown;
}): unknown[] {
  const originalArray = Array.isArray(params.original) ? params.original : [];
  if (params.incoming.length < originalArray.length) {
    log.warn(`Redacted config array key ${params.path} has been truncated`);
  }
  return params.incoming.map((item, index) => params.mapItem(item, index, originalArray));
}

function toObjectRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function restoreArrayItemWithLookup(params: {
  item: unknown;
  index: number;
  originalArray: unknown[];
  lookup: Set<string>;
  path: string;
  hints: ConfigUiHints;
}): unknown {
  if (params.item === REDACTED_SENTINEL) {
    return params.originalArray[params.index];
  }
  return restoreRedactedValuesWithLookup(
    params.item,
    params.originalArray[params.index],
    params.lookup,
    params.path,
    params.hints,
  );
}

function restoreArrayItemWithGuessing(params: {
  item: unknown;
  index: number;
  originalArray: unknown[];
  path: string;
  hints?: ConfigUiHints;
}): unknown {
  if (
    !isExplicitlyNonSensitivePath(params.hints, [params.path]) &&
    isSensitivePath(params.path) &&
    params.item === REDACTED_SENTINEL
  ) {
    return params.originalArray[params.index];
  }
  return restoreRedactedValuesGuessing(
    params.item,
    params.originalArray[params.index],
    params.path,
    params.hints,
  );
}

function restoreGuessingArray(
  incoming: unknown[],
  original: unknown,
  path: string,
  hints?: ConfigUiHints,
): unknown[] {
  return mapRedactedArray({
    incoming,
    original,
    path,
    mapItem: (item, index, originalArray) =>
      restoreArrayItemWithGuessing({
        item,
        index,
        originalArray,
        path,
        hints,
      }),
  });
}

/**
 * Worker for restoreRedactedValues().
 * Used when there are ConfigUiHints available.
 */
function restoreRedactedValuesWithLookup(
  incoming: unknown,
  original: unknown,
  lookup: Set<string>,
  prefix: string,
  hints: ConfigUiHints,
): unknown {
  if (incoming === null || incoming === undefined) {
    return incoming;
  }
  if (typeof incoming !== "object") {
    return incoming;
  }
  if (Array.isArray(incoming)) {
    // Note: If the user removed an item in the middle of the array,
    // we have no way of knowing which one. In this case, the last
    // element(s) get(s) chopped off. Not good, so please don't put
    // sensitive string array in the config...
    const path = `${prefix}[]`;
    if (!lookup.has(path)) {
      if (!isExtensionPath(prefix)) {
        return incoming;
      }
      return restoreRedactedValuesGuessing(incoming, original, prefix, hints);
    }
    return mapRedactedArray({
      incoming,
      original,
      path,
      mapItem: (item, index, originalArray) =>
        restoreArrayItemWithLookup({
          item,
          index,
          originalArray,
          lookup,
          path,
          hints,
        }),
    });
  }
  const orig = toObjectRecord(original);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    result[key] = value;
    const path = prefix ? `${prefix}.${key}` : key;
    const wildcardPath = prefix ? `${prefix}.*` : "*";
    let matched = false;
    for (const candidate of [path, wildcardPath]) {
      if (lookup.has(candidate)) {
        matched = true;
        if (value === REDACTED_SENTINEL) {
          result[key] = restoreOriginalValueOrThrow({ key, path: candidate, original: orig });
        } else if (typeof value === "object" && value !== null) {
          result[key] = restoreRedactedValuesWithLookup(value, orig[key], lookup, candidate, hints);
        }
        break;
      }
    }
    if (!matched && isExtensionPath(path)) {
      const markedNonSensitive = isExplicitlyNonSensitivePath(hints, [path, wildcardPath]);
      if (!markedNonSensitive && isSensitivePath(path) && value === REDACTED_SENTINEL) {
        result[key] = restoreOriginalValueOrThrow({ key, path, original: orig });
      } else if (typeof value === "object" && value !== null) {
        result[key] = restoreRedactedValuesGuessing(value, orig[key], path, hints);
      }
    }
  }
  return result;
}

/**
 * Worker for restoreRedactedValues().
 * Used when ConfigUiHints are NOT available.
 */
function restoreRedactedValuesGuessing(
  incoming: unknown,
  original: unknown,
  prefix: string,
  hints?: ConfigUiHints,
): unknown {
  if (incoming === null || incoming === undefined) {
    return incoming;
  }
  if (typeof incoming !== "object") {
    return incoming;
  }
  if (Array.isArray(incoming)) {
    // Note: If the user removed an item in the middle of the array,
    // we have no way of knowing which one. In this case, the last
    // element(s) get(s) chopped off. Not good, so please don't put
    // sensitive string array in the config...
    const path = `${prefix}[]`;
    return restoreGuessingArray(incoming, original, path, hints);
  }
  const orig = toObjectRecord(original);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const wildcardPath = prefix ? `${prefix}.*` : "*";
    if (
      !isExplicitlyNonSensitivePath(hints, [path, wildcardPath]) &&
      isSensitivePath(path) &&
      value === REDACTED_SENTINEL
    ) {
      result[key] = restoreOriginalValueOrThrow({ key, path, original: orig });
    } else if (typeof value === "object" && value !== null) {
      result[key] = restoreRedactedValuesGuessing(value, orig[key], path, hints);
    } else {
      result[key] = value;
    }
  }
  return result;
}
