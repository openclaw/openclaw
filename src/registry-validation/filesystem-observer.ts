// Filesystem observer.
// Read-only: existence, type, readability, optional stat metadata, optional bounded non-recursive listing.
// Never invokes writeFile, appendFile, mkdir, rm, unlink, rename, chmod, chown, or recursive enumeration.
// Does not assign ResolutionStatus or CapabilityStatus.
import type { Stats } from "node:fs";
import type { EvidenceRecord } from "../config/zod-schema.registry-validation.js";
import { createEvidenceRecord } from "./observer-evidence.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FilesystemOutcome =
  | "EXISTS_READABLE"
  | "EXISTS_UNREADABLE"
  | "MISSING"
  | "WRONG_TYPE"
  | "ACCESS_ERROR"
  | "INVALID_PATH"
  | "UNKNOWN"
  | "INTERNAL_ERROR";

export type ExpectedType = "file" | "directory";

export interface FilesystemObserverDeps {
  /** Injected fs.existsSync or equivalent. */
  existsSync: (path: string) => boolean;
  /** Injected fs.statSync or equivalent. */
  statSync: (path: string) => Stats;
  /** Injected fs.accessSync or equivalent. */
  accessSync: (path: string, mode?: number) => void;
  /** Optional injected readdir for bounded non-recursive listing. */
  readdirSync?: (path: string) => string[];
  /** Node fs.constants for access modes. */
  constants: { R_OK: number };
}

export interface FilesystemObservationResult {
  path: string;
  outcome: FilesystemOutcome;
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  readable: boolean;
  statMetadata: StatMetadata | null;
  listing: string[] | null;
  evidence: EvidenceRecord[];
  error: string | null;
}

export interface StatMetadata {
  size: number;
  mtime: string | null;
  isSymlink: boolean;
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/**
 * Observes a filesystem path for existence, type, and readability.
 * All fs operations are injected — no direct filesystem access.
 * Path is passed through as-is; Node.js fs APIs handle platform path semantics.
 */
export function observeFilesystem(
  targetPath: string,
  expectedType: ExpectedType | null,
  deps: FilesystemObserverDeps,
  meta: { now: () => string; wantListing?: boolean },
): FilesystemObservationResult {
  const collectedAt = meta.now();
  const evidence: EvidenceRecord[] = [];
  const wantListing = meta.wantListing ?? false;

  // Validate path
  if (!targetPath || targetPath.trim() === "") {
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "FILESYSTEM",
          source: "filesystem-observer",
          collector: "FilesystemObserver",
          confidence: "LOW",
          value: null,
          notes: "Invalid path: empty or whitespace",
        },
        collectedAt,
      ),
    );
    return emptyResult(targetPath, "INVALID_PATH", evidence, "Path is empty or whitespace");
  }

  const normalizedPath = targetPath;

  // Check existence
  let exists: boolean;
  try {
    exists = deps.existsSync(normalizedPath);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "FILESYSTEM",
          source: "filesystem-observer",
          collector: "FilesystemObserver",
          confidence: "LOW",
          value: null,
          notes: `Access error on existsSync: ${errMsg}`,
        },
        collectedAt,
      ),
    );
    return emptyResult(normalizedPath, "ACCESS_ERROR", evidence, `existsSync error: ${errMsg}`);
  }

  if (!exists) {
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "FILESYSTEM",
          source: "filesystem-observer",
          collector: "FilesystemObserver",
          confidence: "HIGH",
          value: null,
          notes: `Path missing: ${normalizedPath}`,
        },
        collectedAt,
      ),
    );
    return emptyResult(normalizedPath, "MISSING", evidence, null);
  }

  // Stat the path
  let stat: Stats;
  try {
    stat = deps.statSync(normalizedPath);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "FILESYSTEM",
          source: "filesystem-observer",
          collector: "FilesystemObserver",
          confidence: "LOW",
          value: null,
          notes: `Access error on statSync: ${errMsg}`,
        },
        collectedAt,
      ),
    );
    return emptyResult(normalizedPath, "ACCESS_ERROR", evidence, `statSync error: ${errMsg}`);
  }

  const isFile = stat.isFile();
  const isDirectory = stat.isDirectory();
  const isSymlink = stat.isSymbolicLink();

  // Check type expectation
  if (expectedType !== null) {
    if (expectedType === "file" && !isFile) {
      evidence.push(
        createEvidenceRecord(
          {
            evidenceType: "FILESYSTEM",
            source: "filesystem-observer",
            collector: "FilesystemObserver",
            confidence: "HIGH",
            value: null,
            notes: `Wrong type: expected file, got ${isDirectory ? "directory" : "other"}`,
          },
          collectedAt,
        ),
      );
      return emptyResult(
        normalizedPath,
        "WRONG_TYPE",
        evidence,
        `Expected file, got ${isDirectory ? "directory" : "other"}`,
      );
    }
    if (expectedType === "directory" && !isDirectory) {
      evidence.push(
        createEvidenceRecord(
          {
            evidenceType: "FILESYSTEM",
            source: "filesystem-observer",
            collector: "FilesystemObserver",
            confidence: "HIGH",
            value: null,
            notes: `Wrong type: expected directory, got ${isFile ? "file" : "other"}`,
          },
          collectedAt,
        ),
      );
      return emptyResult(
        normalizedPath,
        "WRONG_TYPE",
        evidence,
        `Expected directory, got ${isFile ? "file" : "other"}`,
      );
    }
  }

  // Check readability
  let readable: boolean;
  try {
    deps.accessSync(normalizedPath, deps.constants.R_OK);
    readable = true;
  } catch {
    readable = false;
  }

  // Stat metadata
  const statMetadata: StatMetadata | null = {
    size: stat.size,
    mtime: stat.mtime ? stat.mtime.toISOString() : null,
    isSymlink,
  };

  // Optional bounded non-recursive listing
  let listing: string[] | null = null;
  if (wantListing && isDirectory && readable && deps.readdirSync) {
    try {
      listing = deps.readdirSync(normalizedPath);
    } catch {
      listing = null;
    }
  }

  const outcome: FilesystemOutcome = readable ? "EXISTS_READABLE" : "EXISTS_UNREADABLE";

  evidence.push(
    createEvidenceRecord(
      {
        evidenceType: "FILESYSTEM",
        source: "filesystem-observer",
        collector: "FilesystemObserver",
        confidence: "HIGH",
        value: normalizedPath,
        notes: `Path exists: ${isFile ? "file" : isDirectory ? "directory" : "other"}, readable: ${readable}, symlink: ${isSymlink}`,
      },
      collectedAt,
    ),
  );

  return {
    path: normalizedPath,
    outcome,
    exists: true,
    isFile,
    isDirectory,
    readable,
    statMetadata,
    listing,
    evidence,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyResult(
  path: string,
  outcome: FilesystemOutcome,
  evidence: EvidenceRecord[],
  error: string | null,
): FilesystemObservationResult {
  return {
    path,
    outcome,
    exists: false,
    isFile: false,
    isDirectory: false,
    readable: false,
    statMetadata: null,
    listing: null,
    evidence,
    error,
  };
}
