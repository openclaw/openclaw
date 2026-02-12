/**
 * Preserves `$include` directives during config write-back.
 *
 * When config is read, `$include` directives are resolved by loading and merging
 * the referenced files. When writing back, callers pass the fully resolved config.
 * This module reconstructs the original `$include` structure so that:
 *
 * 1. `$include` directives remain in the written file (not flattened)
 * 2. Keys that came from included files are NOT inlined into the root config
 * 3. New or changed values that the caller added are written as local overrides
 *
 * This prevents secret leakage (included files often reference `${ENV_VAR}` patterns)
 * and preserves the modular config structure users intentionally set up.
 *
 * Strategy: We track which keys existed as explicit siblings of `$include` in the
 * raw parsed config. Only those keys (plus genuinely new keys not present in any
 * included file) are written to the output. For sibling keys that overlap with
 * included content, we propagate the included content down through recursion so
 * that deeply nested keys from includes are also excluded.
 */

import path from "node:path";
import { isPlainObject } from "../utils.js";
import { INCLUDE_KEY, type IncludeResolver } from "./includes.js";

/**
 * Given the resolved config about to be written and the raw (pre-resolution)
 * parsed config from disk, produce a config object that preserves `$include`
 * directives while applying any changes the caller made.
 *
 * @param incoming - The fully resolved config about to be written
 * @param rawParsed - The raw parsed config from disk (before include resolution)
 * @param includeMap - Map of include path (as written in config) → resolved content
 *   (should have env vars resolved for accurate comparison)
 * @returns A config object suitable for writing, with `$include` preserved
 */
export function restoreIncludeDirectives(
  incoming: unknown,
  rawParsed: unknown,
  includeMap: Map<string, unknown>,
): unknown {
  if (!isPlainObject(incoming) || !isPlainObject(rawParsed)) {
    return incoming;
  }

  return restoreIncludes(incoming, rawParsed, includeMap, null);
}

/**
 * Core recursive restore function.
 *
 * @param includedContext - Content provided by a parent-level `$include` for this
 *   subtree. Used to identify keys that came from includes even when the current
 *   level has no `$include` directive of its own.
 */
function restoreIncludes(
  incoming: Record<string, unknown>,
  rawParsed: Record<string, unknown>,
  includeMap: Map<string, unknown>,
  includedContext: Record<string, unknown> | null,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (INCLUDE_KEY in rawParsed) {
    const includeValue = rawParsed[INCLUDE_KEY];
    result[INCLUDE_KEY] = includeValue;

    // Merge the content from all included files at this level
    const includedContent = mergeIncludedContent(includeValue, includeMap);

    // The sibling keys in the raw parsed config are the keys the user
    // explicitly put in the main file alongside the $include
    const rawSiblingKeys = new Set(Object.keys(rawParsed).filter((k) => k !== INCLUDE_KEY));

    // Write back sibling keys that existed in rawParsed
    for (const key of rawSiblingKeys) {
      if (key in incoming) {
        // If the include also provides this key, pass its value down as context
        // so nested levels can exclude keys that came from the include
        const nestedIncluded =
          includedContent && key in includedContent && isPlainObject(includedContent[key])
            ? includedContent[key]
            : null;
        result[key] = restoreNestedIncludes(
          incoming[key],
          rawParsed[key],
          includeMap,
          nestedIncluded,
        );
      }
      // If key was removed from incoming, don't write it (intentional deletion)
    }

    // Check for new keys in incoming that weren't sibling keys in rawParsed
    for (const key of Object.keys(incoming)) {
      if (key in result || key === INCLUDE_KEY) {
        continue;
      }

      if (includedContent && key in includedContent) {
        // This key came from an included file — don't inline it.
        // The included file is the source of truth for this key.
        continue;
      }

      // Genuinely new key not from any include — write it
      result[key] = incoming[key];
    }

    return result;
  }

  // No $include at this level — recurse into nested objects,
  // using includedContext to identify keys that came from a parent-level include
  for (const key of Object.keys(incoming)) {
    if (key in rawParsed) {
      // Key exists in both raw and incoming — recurse, passing down any
      // included context for this key
      const nestedIncluded =
        includedContext && key in includedContext && isPlainObject(includedContext[key])
          ? includedContext[key]
          : null;
      result[key] = restoreNestedIncludes(
        incoming[key],
        rawParsed[key],
        includeMap,
        nestedIncluded,
      );
    } else if (includedContext && key in includedContext) {
      // Key came from a parent-level include — check if value was changed
      if (deepEqual(incoming[key], includedContext[key])) {
        // Unchanged from included value — don't inline
        continue;
      }
      // Value was changed by the caller — write as local override
      result[key] = incoming[key];
    } else {
      // New key not in raw or included — write it
      result[key] = incoming[key];
    }
  }

  return result;
}

/**
 * Recurse into nested values, restoring includes at any depth.
 */
function restoreNestedIncludes(
  incoming: unknown,
  rawParsed: unknown,
  includeMap: Map<string, unknown>,
  includedContext: Record<string, unknown> | null,
): unknown {
  if (isPlainObject(incoming) && isPlainObject(rawParsed)) {
    return restoreIncludes(incoming, rawParsed, includeMap, includedContext);
  }
  // For non-object values, check if the value matches included content
  if (includedContext !== null) {
    // At this level we have included context but the rawParsed is not an object —
    // the incoming value is used as-is (it's a primitive override)
    return incoming;
  }
  return incoming;
}

/**
 * Merge the resolved content of all included files for a given `$include` value.
 */
function mergeIncludedContent(
  includeValue: unknown,
  includeMap: Map<string, unknown>,
): Record<string, unknown> | null {
  const paths =
    typeof includeValue === "string"
      ? [includeValue]
      : Array.isArray(includeValue)
        ? includeValue.filter((p): p is string => typeof p === "string")
        : [];

  if (paths.length === 0) {
    return null;
  }

  const merged: Record<string, unknown> = {};
  for (const p of paths) {
    const resolved = includeMap.get(p);
    if (isPlainObject(resolved)) {
      deepMergeInto(merged, resolved);
    }
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Deep merge source into target (mutates target).
 * Matches the merge semantics used by the include resolver.
 */
function deepMergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (key in target && isPlainObject(target[key]) && isPlainObject(source[key])) {
      deepMergeInto(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

/**
 * Deep equality check for comparing included values with incoming values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  if (typeof a !== typeof b) {
    return false;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) {
      return false;
    }
    return keysA.every((key) => key in b && deepEqual(a[key], b[key]));
  }

  return false;
}

// ============================================================================
// Helper: build a map of include paths to their raw resolved content
// ============================================================================

/**
 * Walk a raw parsed config and resolve each `$include` path, building a map
 * of include-path → resolved content. This is used by restoreIncludeDirectives
 * to know what came from each included file.
 *
 * The resolved content is the raw parsed JSON of the included file — it is NOT
 * recursively include-resolved. This is intentional: we only need the top-level
 * keys to determine what came from each include.
 *
 * @param rawParsed - The raw parsed config (before include resolution)
 * @param configPath - Path to the config file (for resolving relative paths)
 * @param resolver - The include resolver (file reader + JSON parser)
 * @returns Map of include path (as written in config) → raw parsed content
 */
export function buildIncludeMap(
  rawParsed: unknown,
  configPath: string,
  resolver: IncludeResolver,
): Map<string, unknown> {
  const map = new Map<string, unknown>();
  collectIncludes(rawParsed, configPath, resolver, map);
  return map;
}

function collectIncludes(
  obj: unknown,
  basePath: string,
  resolver: IncludeResolver,
  map: Map<string, unknown>,
): void {
  if (!isPlainObject(obj)) {
    return;
  }

  if (INCLUDE_KEY in obj) {
    const includeValue = obj[INCLUDE_KEY];
    const paths =
      typeof includeValue === "string"
        ? [includeValue]
        : Array.isArray(includeValue)
          ? includeValue.filter((p): p is string => typeof p === "string")
          : [];

    for (const includePath of paths) {
      if (map.has(includePath)) {
        continue;
      }
      try {
        const resolvedPath = path.isAbsolute(includePath)
          ? includePath
          : path.resolve(path.dirname(basePath), includePath);
        const raw = resolver.readFile(resolvedPath);
        const parsed = resolver.parseJson(raw);
        map.set(includePath, parsed);
        // Recurse into included file for nested includes
        collectIncludes(parsed, resolvedPath, resolver, map);
      } catch {
        // If we can't read the include, skip it — preservation will fall back
        // to writing the incoming value as-is
      }
    }
  }

  // Recurse into nested objects for nested includes
  for (const [key, value] of Object.entries(obj)) {
    if (key !== INCLUDE_KEY) {
      collectIncludes(value, basePath, resolver, map);
    }
  }
}
