/**
 * Config includes: $include directive for modular configs
 *
 * @example
 * ```json5
 * {
 *   "$include": "./base.json5",           // single file
 *   "$include": ["./a.json5", "./b.json5"] // merge multiple
 * }
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { canUseBoundaryFileOpen, openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isPathInside } from "../security/scan-paths.js";
import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

export const INCLUDE_KEY = "$include";
export const MAX_INCLUDE_DEPTH = 10;
export const MAX_INCLUDE_FILE_BYTES = 2 * 1024 * 1024;

// ============================================================================
// Types
// ============================================================================

export type IncludeResolver = {
  readFile: (path: string) => string;
  readFileWithGuards?: (params: IncludeFileReadParams) => string;
  parseJson: (raw: string) => unknown;
};

export type IncludeFileReadParams = {
  includePath: string;
  resolvedPath: string;
  rootRealDir: string;
  ioFs?: typeof fs;
  maxBytes?: number;
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
    super(`Circular include detected: ${chain.join(" -> ")}`, chain[chain.length - 1]);
    this.name = "CircularIncludeError";
  }
}

// ============================================================================
// Utilities
// ============================================================================

/** Deep merge: arrays concatenate, objects merge recursively, primitives: source wins */
export function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      if (isBlockedObjectKey(key)) {
        continue;
      }
      result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
    }
    return result;
  }
  return source;
}

// ============================================================================
// Include Resolver Class
// ============================================================================

class IncludeProcessor {
  private visited = new Set<string>();
  private depth = 0;
  private readonly rootDir: string;
  private readonly rootRealDir: string;

  constructor(
    private basePath: string,
    private resolver: IncludeResolver,
    rootDir?: string,
  ) {
    this.visited.add(path.normalize(basePath));
    this.rootDir = path.normalize(rootDir ?? path.dirname(basePath));
    this.rootRealDir = path.normalize(safeRealpath(this.rootDir));
  }

  process(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.process(item));
    }

    if (!isPlainObject(obj)) {
      return obj;
    }

    if (!(INCLUDE_KEY in obj)) {
      return this.processObject(obj);
    }

    return this.processInclude(obj);
  }

  private processObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.process(value);
    }
    return result;
  }

  private processInclude(obj: Record<string, unknown>): unknown {
    const includeValue = obj[INCLUDE_KEY];
    const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);
    const included = this.resolveInclude(includeValue);

    if (otherKeys.length === 0) {
      return included;
    }

    if (!isPlainObject(included)) {
      throw new ConfigIncludeError(
        "Sibling keys require included content to be an object",
        typeof includeValue === "string" ? includeValue : INCLUDE_KEY,
      );
    }

    // Merge included content with sibling keys
    const rest: Record<string, unknown> = {};
    for (const key of otherKeys) {
      rest[key] = this.process(obj[key]);
    }
    return deepMerge(included, rest);
  }

  private resolveInclude(value: unknown): unknown {
    if (typeof value === "string") {
      return this.loadFile(value);
    }

    if (Array.isArray(value)) {
      return value.reduce<unknown>((merged, item) => {
        if (typeof item !== "string") {
          throw new ConfigIncludeError(
            `Invalid $include array item: expected string, got ${typeof item}`,
            String(item),
          );
        }
        return deepMerge(merged, this.loadFile(item));
      }, {});
    }

    throw new ConfigIncludeError(
      `Invalid $include value: expected string or array of strings, got ${typeof value}`,
      String(value),
    );
  }

  private loadFile(includePath: string): unknown {
    const resolvedPath = this.resolvePath(includePath);

    this.checkCircular(resolvedPath);
    this.checkDepth(includePath);

    const raw = this.readFile(includePath, resolvedPath);
    const parsed = this.parseFile(includePath, resolvedPath, raw);

    return this.processNested(resolvedPath, parsed);
  }

  private resolvePath(includePath: string): string {
    const configDir = path.dirname(this.basePath);
    const resolved = path.isAbsolute(includePath)
      ? includePath
      : path.resolve(configDir, includePath);
    const normalized = path.normalize(resolved);

    // SECURITY: Reject paths outside top-level config directory (CWE-22: Path Traversal)
    if (!isPathInside(this.rootDir, normalized)) {
      throw new ConfigIncludeError(
        `Include path escapes config directory: ${includePath} (root: ${this.rootDir})`,
        includePath,
      );
    }

    // SECURITY: Resolve symlinks and re-validate to prevent symlink bypass
    try {
      const real = fs.realpathSync(normalized);
      if (!isPathInside(this.rootRealDir, real)) {
        throw new ConfigIncludeError(
          `Include path resolves outside config directory (symlink): ${includePath} (root: ${this.rootDir})`,
          includePath,
        );
      }
    } catch (err) {
      if (err instanceof ConfigIncludeError) {
        throw err;
      }
      // File doesn't exist yet - normalized path check above is sufficient
    }

    return normalized;
  }

  private checkCircular(resolvedPath: string): void {
    if (this.visited.has(resolvedPath)) {
      throw new CircularIncludeError([...this.visited, resolvedPath]);
    }
  }

  private checkDepth(includePath: string): void {
    if (this.depth >= MAX_INCLUDE_DEPTH) {
      throw new ConfigIncludeError(
        `Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded at: ${includePath}`,
        includePath,
      );
    }
  }

  private readFile(includePath: string, resolvedPath: string): string {
    try {
      if (this.resolver.readFileWithGuards) {
        return this.resolver.readFileWithGuards({
          includePath,
          resolvedPath,
          rootRealDir: this.rootRealDir,
        });
      }
      return this.resolver.readFile(resolvedPath);
    } catch (err) {
      if (err instanceof ConfigIncludeError) {
        throw err;
      }
      throw new ConfigIncludeError(
        `Failed to read include file: ${includePath} (resolved: ${resolvedPath})`,
        includePath,
        err instanceof Error ? err : undefined,
      );
    }
  }

  private parseFile(includePath: string, resolvedPath: string, raw: string): unknown {
    try {
      return this.resolver.parseJson(raw);
    } catch (err) {
      throw new ConfigIncludeError(
        `Failed to parse include file: ${includePath} (resolved: ${resolvedPath})`,
        includePath,
        err instanceof Error ? err : undefined,
      );
    }
  }

  private processNested(resolvedPath: string, parsed: unknown): unknown {
    const nested = new IncludeProcessor(resolvedPath, this.resolver, this.rootDir);
    nested.visited = new Set([...this.visited, resolvedPath]);
    nested.depth = this.depth + 1;
    return nested.process(parsed);
  }
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

export function readConfigIncludeFileWithGuards(params: IncludeFileReadParams): string {
  const ioFs = params.ioFs ?? fs;
  const maxBytes = params.maxBytes ?? MAX_INCLUDE_FILE_BYTES;
  if (!canUseBoundaryFileOpen(ioFs)) {
    return ioFs.readFileSync(params.resolvedPath, "utf-8");
  }

  const opened = openBoundaryFileSync({
    absolutePath: params.resolvedPath,
    rootPath: params.rootRealDir,
    rootRealPath: params.rootRealDir,
    boundaryLabel: "config directory",
    skipLexicalRootCheck: true,
    maxBytes,
    ioFs,
  });
  if (!opened.ok) {
    if (opened.reason === "validation") {
      throw new ConfigIncludeError(
        `Include file failed security checks (regular file, max ${maxBytes} bytes, no hardlinks): ${params.includePath}`,
        params.includePath,
      );
    }
    throw new ConfigIncludeError(
      `Failed to read include file: ${params.includePath} (resolved: ${params.resolvedPath})`,
      params.includePath,
      opened.error instanceof Error ? opened.error : undefined,
    );
  }

  try {
    return ioFs.readFileSync(opened.fd, "utf-8");
  } finally {
    ioFs.closeSync(opened.fd);
  }
}

// ============================================================================
// Public API
// ============================================================================

const defaultResolver: IncludeResolver = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
    readConfigIncludeFileWithGuards({ includePath, resolvedPath, rootRealDir }),
  parseJson: (raw) => JSON5.parse(raw),
};

/**
 * Resolves all $include directives in a parsed config object.
 */
export function resolveConfigIncludes(
  obj: unknown,
  configPath: string,
  resolver: IncludeResolver = defaultResolver,
): unknown {
  return new IncludeProcessor(configPath, resolver).process(obj);
}
