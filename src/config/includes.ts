/**
 * Config includes: $include directive for modular configs
 *
 * Supports:
 * - `{ "$include": "./path/to/file.json5" }` - single file include
 * - `{ "$include": ["./a.json5", "./b.json5"] }` - deep merge multiple files
 * - Nested includes up to MAX_INCLUDE_DEPTH levels
 * - Circular include detection
 */

import fs from "node:fs";
import path from "node:path";

import JSON5 from "json5";

// ============================================================================
// Constants
// ============================================================================

export const INCLUDE_KEY = "$include";
export const MAX_INCLUDE_DEPTH = 10;

// ============================================================================
// Types
// ============================================================================

export type IncludeResolver = {
  fsModule: typeof fs;
  json5Module: typeof JSON5;
};

type IncludeContext = {
  basePath: string;
  visited: Set<string>;
  depth: number;
  resolver: IncludeResolver;
};

// ============================================================================
// Errors
// ============================================================================

export class ConfigIncludeError extends Error {
  constructor(
    message: string,
    public readonly includePath: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "ConfigIncludeError";
  }
}

export class CircularIncludeError extends ConfigIncludeError {
  constructor(public readonly chain: string[]) {
    super(
      `Circular include detected: ${chain.join(" -> ")}`,
      chain[chain.length - 1],
    );
    this.name = "CircularIncludeError";
  }
}

// ============================================================================
// Utilities
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Deep merge two values.
 * - Arrays: concatenate
 * - Objects: recursive merge
 * - Primitives: source wins
 */
export function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      result[key] =
        key in result ? deepMerge(result[key], source[key]) : source[key];
    }
    return result;
  }
  return source;
}

function resolveIncludePath(includePath: string, basePath: string): string {
  if (path.isAbsolute(includePath)) {
    return includePath;
  }
  return path.resolve(path.dirname(basePath), includePath);
}

// ============================================================================
// Core Logic
// ============================================================================

function loadIncludeFile(includePath: string, ctx: IncludeContext): unknown {
  const resolvedPath = resolveIncludePath(includePath, ctx.basePath);
  const normalizedPath = path.normalize(resolvedPath);

  if (ctx.visited.has(normalizedPath)) {
    throw new CircularIncludeError([...ctx.visited, normalizedPath]);
  }

  if (ctx.depth >= MAX_INCLUDE_DEPTH) {
    throw new ConfigIncludeError(
      `Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded at: ${includePath}`,
      includePath,
    );
  }

  let raw: string;
  try {
    raw = ctx.resolver.fsModule.readFileSync(normalizedPath, "utf-8");
  } catch (err) {
    throw new ConfigIncludeError(
      `Failed to read include file: ${includePath} (resolved: ${normalizedPath})`,
      includePath,
      err instanceof Error ? err : undefined,
    );
  }

  let parsed: unknown;
  try {
    parsed = ctx.resolver.json5Module.parse(raw);
  } catch (err) {
    throw new ConfigIncludeError(
      `Failed to parse include file: ${includePath} (resolved: ${normalizedPath})`,
      includePath,
      err instanceof Error ? err : undefined,
    );
  }

  const newCtx: IncludeContext = {
    ...ctx,
    basePath: normalizedPath,
    visited: new Set([...ctx.visited, normalizedPath]),
    depth: ctx.depth + 1,
  };

  return resolveIncludesInternal(parsed, newCtx);
}

function resolveIncludeDirective(
  includeValue: unknown,
  ctx: IncludeContext,
): unknown {
  if (typeof includeValue === "string") {
    return loadIncludeFile(includeValue, ctx);
  }

  if (Array.isArray(includeValue)) {
    let result: unknown = {};
    for (const item of includeValue) {
      if (typeof item !== "string") {
        throw new ConfigIncludeError(
          `Invalid $include array item: expected string, got ${typeof item}`,
          String(item),
        );
      }
      result = deepMerge(result, loadIncludeFile(item, ctx));
    }
    return result;
  }

  throw new ConfigIncludeError(
    `Invalid $include value: expected string or array of strings, got ${typeof includeValue}`,
    String(includeValue),
  );
}

function resolveIncludesInternal(obj: unknown, ctx: IncludeContext): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveIncludesInternal(item, ctx));
  }

  if (isPlainObject(obj)) {
    if (INCLUDE_KEY in obj) {
      const includeValue = obj[INCLUDE_KEY];
      const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);

      if (otherKeys.length > 0) {
        const included = resolveIncludeDirective(includeValue, ctx);
        const rest: Record<string, unknown> = {};
        for (const key of otherKeys) {
          rest[key] = resolveIncludesInternal(obj[key], ctx);
        }
        return deepMerge(included, rest);
      }

      return resolveIncludeDirective(includeValue, ctx);
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveIncludesInternal(value, ctx);
    }
    return result;
  }

  return obj;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolves all $include directives in a parsed config object.
 *
 * @param obj - Parsed config object (from JSON5.parse)
 * @param configPath - Path to the main config file (for relative path resolution)
 * @param resolver - Optional custom fs/json5 modules (for testing)
 * @returns Config object with all includes resolved
 *
 * @example
 * ```typescript
 * const parsed = JSON5.parse(raw);
 * const resolved = resolveConfigIncludes(parsed, "/path/to/config.json5");
 * ```
 */
export function resolveConfigIncludes(
  obj: unknown,
  configPath: string,
  resolver: IncludeResolver = { fsModule: fs, json5Module: JSON5 },
): unknown {
  const ctx: IncludeContext = {
    basePath: configPath,
    visited: new Set([path.normalize(configPath)]),
    depth: 0,
    resolver,
  };
  return resolveIncludesInternal(obj, ctx);
}
