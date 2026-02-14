/**
 * Security utilities for hook module loading
 *
 * Provides path validation to prevent CWE-94 (Code Injection) in dynamic
 * module loading. All paths must be validated before being passed to import().
 *
 * Validation is synchronous to prevent TOCTOU issues. Paths are canonicalized
 * via realpathSync to resolve symlinks and traversal sequences, then checked
 * against an allowlist of base directories.
 */

import fs from "node:fs";
import path from "node:path";

const ALLOWED_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".mts"]);

/** Branded type for paths that have passed validation. */
export type ValidatedModulePath = string & { readonly __brand: "ValidatedModulePath" };

export type PathValidationResult =
  | { valid: true; path: ValidatedModulePath }
  | { valid: false; reason: PathValidationError };

export enum PathValidationError {
  PATH_EMPTY = "PATH_EMPTY",
  PATH_OUTSIDE_ALLOWED_DIRS = "PATH_OUTSIDE_ALLOWED_DIRS",
  PATH_TRAVERSAL_DETECTED = "PATH_TRAVERSAL_DETECTED",
  INVALID_EXTENSION = "INVALID_EXTENSION",
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  SYMLINK_ESCAPE = "SYMLINK_ESCAPE",
  RESOLUTION_FAILED = "RESOLUTION_FAILED",
}

const ERROR_DESCRIPTIONS: Record<PathValidationError, string> = {
  [PathValidationError.PATH_EMPTY]: "Module path is empty or undefined",
  [PathValidationError.PATH_OUTSIDE_ALLOWED_DIRS]: "Module path is outside allowed directories",
  [PathValidationError.PATH_TRAVERSAL_DETECTED]: "Path traversal sequence detected",
  [PathValidationError.INVALID_EXTENSION]: "Module has disallowed file extension",
  [PathValidationError.FILE_NOT_FOUND]: "Module file does not exist",
  [PathValidationError.SYMLINK_ESCAPE]: "Symlink resolves outside allowed directories",
  [PathValidationError.RESOLUTION_FAILED]: "Failed to resolve module path",
};

export function getErrorDescription(error: PathValidationError): string {
  return ERROR_DESCRIPTIONS[error] ?? "Unknown validation error";
}

export interface PathValidatorConfig {
  allowedBaseDirs: readonly string[];
  /** Whether to follow and validate symlinks (default: true) */
  resolveSymlinks?: boolean;
  /** Additional allowed extensions beyond the defaults (.js, .mjs, .ts, .mts) */
  additionalExtensions?: readonly string[];
}

/**
 * Validates and canonicalizes a module path for safe dynamic import.
 *
 * Validation layers:
 * 1. Input sanitization (empty/null checks)
 * 2. Traversal pattern detection (../, encoded variants)
 * 3. Path canonicalization (resolves symlinks via realpathSync)
 * 4. Extension allowlist check
 * 5. Directory containment check (must be within allowed dirs)
 */
export function validateModulePath(
  inputPath: string | undefined | null,
  config: PathValidatorConfig,
): PathValidationResult {
  if (!inputPath || typeof inputPath !== "string" || inputPath.trim() === "") {
    return { valid: false, reason: PathValidationError.PATH_EMPTY };
  }

  const trimmedPath = inputPath.trim();

  // Pre-resolution check for traversal sequences
  if (containsTraversalSequence(trimmedPath)) {
    return { valid: false, reason: PathValidationError.PATH_TRAVERSAL_DETECTED };
  }

  let canonicalPath: string;
  try {
    const absolutePath = path.isAbsolute(trimmedPath) ? trimmedPath : path.resolve(trimmedPath);

    if (config.resolveSymlinks !== false) {
      canonicalPath = fs.realpathSync(absolutePath);
    } else {
      canonicalPath = path.normalize(absolutePath);
      if (!fs.existsSync(canonicalPath)) {
        return { valid: false, reason: PathValidationError.FILE_NOT_FOUND };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { valid: false, reason: PathValidationError.FILE_NOT_FOUND };
    }
    return { valid: false, reason: PathValidationError.RESOLUTION_FAILED };
  }

  // Extension check
  const allowedExts = config.additionalExtensions?.length
    ? new Set([...ALLOWED_EXTENSIONS, ...config.additionalExtensions])
    : ALLOWED_EXTENSIONS;

  const ext = path.extname(canonicalPath).toLowerCase();
  if (!allowedExts.has(ext)) {
    return { valid: false, reason: PathValidationError.INVALID_EXTENSION };
  }

  // Directory containment check
  const canonicalAllowedDirs = config.allowedBaseDirs
    .map((dir) => {
      try {
        return fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
      } catch {
        return path.resolve(dir);
      }
    })
    .filter((dir) => dir.length > 0);

  const isWithinAllowedDir = canonicalAllowedDirs.some((allowedDir) => {
    const withSep = allowedDir.endsWith(path.sep) ? allowedDir : allowedDir + path.sep;
    return canonicalPath === allowedDir || canonicalPath.startsWith(withSep);
  });

  if (!isWithinAllowedDir) {
    // A symlink escape is when the input path appears to be under an allowed
    // directory but resolves outside it. Compare against raw (non-canonicalized)
    // allowed dirs to avoid false positives from system symlinks like /tmp -> /private/tmp.
    const unresolvedAbsolute = path.isAbsolute(trimmedPath)
      ? trimmedPath
      : path.resolve(trimmedPath);
    const appearedWithinAllowed = config.allowedBaseDirs.some((dir) => {
      const absDir = path.isAbsolute(dir) ? dir : path.resolve(dir);
      const withSep = absDir.endsWith(path.sep) ? absDir : absDir + path.sep;
      return unresolvedAbsolute.startsWith(withSep) || unresolvedAbsolute === absDir;
    });

    if (appearedWithinAllowed) {
      return { valid: false, reason: PathValidationError.SYMLINK_ESCAPE };
    }
    return { valid: false, reason: PathValidationError.PATH_OUTSIDE_ALLOWED_DIRS };
  }

  return { valid: true, path: canonicalPath as ValidatedModulePath };
}

/**
 * Detects path traversal sequences including URL-encoded and unicode variants.
 */
function containsTraversalSequence(pathStr: string): boolean {
  const normalized = pathStr.replace(/\\/g, "/");

  const traversalPatterns = [
    /\.\.\//, // ../ (also covers ..\ after normalization)
    /\.\.$/, // ends with ..
    /%2e%2e/i, // URL-encoded
    /%252e%252e/i, // double-encoded
    /\.%2e/i, // mixed encoding
    /%2e\./i, // mixed encoding
    /\.\uFF0F\./i, // fullwidth solidus (U+FF0F)
    /\.\u2215\./i, // division slash (U+2215)
    /\.\uFF3C\./i, // fullwidth reverse solidus (U+FF3C)
  ];

  return traversalPatterns.some((pattern) => pattern.test(normalized));
}
}

/**
 * Validates a directory path for use as an extra hooks directory.
 * Must be an existing directory; optionally constrained to base directories.
 */
export function validateExtraHooksDir(
  dirPath: string | undefined | null,
  baseAllowedDirs?: readonly string[],
): PathValidationResult {
  if (!dirPath || typeof dirPath !== "string" || dirPath.trim() === "") {
    return { valid: false, reason: PathValidationError.PATH_EMPTY };
  }

  const trimmedPath = dirPath.trim();

  if (containsTraversalSequence(trimmedPath)) {
    return { valid: false, reason: PathValidationError.PATH_TRAVERSAL_DETECTED };
  }

  let canonicalPath: string;
  try {
    const absolutePath = path.isAbsolute(trimmedPath) ? trimmedPath : path.resolve(trimmedPath);
    canonicalPath = fs.realpathSync(absolutePath);

    if (!fs.statSync(canonicalPath).isDirectory()) {
      return { valid: false, reason: PathValidationError.FILE_NOT_FOUND };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { valid: false, reason: PathValidationError.FILE_NOT_FOUND };
    }
    return { valid: false, reason: PathValidationError.RESOLUTION_FAILED };
  }

  if (baseAllowedDirs && baseAllowedDirs.length > 0) {
    const canonicalAllowedDirs = baseAllowedDirs
      .map((dir) => {
        try {
          return fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
        } catch {
          return path.resolve(dir);
        }
      })
      .filter((dir) => dir.length > 0);

    const isWithinAllowedDir = canonicalAllowedDirs.some((allowedDir) => {
      const withSep = allowedDir.endsWith(path.sep) ? allowedDir : allowedDir + path.sep;
      return canonicalPath === allowedDir || canonicalPath.startsWith(withSep);
    });

    if (!isWithinAllowedDir) {
      return { valid: false, reason: PathValidationError.PATH_OUTSIDE_ALLOWED_DIRS };
    }
  }

  return { valid: true, path: canonicalPath as ValidatedModulePath };
}
