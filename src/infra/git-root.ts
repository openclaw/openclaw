// Discovers git repository roots by walking ancestor directories.
import fs from "node:fs";
import path from "node:path";
import { isMissingPathError } from "./errors.js";
import { readFileWindowFullySync } from "./file-read.js";

function walkUpFrom<T>(
  startDir: string,
  opts: { maxDepth?: number },
  resolveAtDir: (dir: string) => T | null | undefined,
): T | null {
  let current = path.resolve(startDir);
  for (let i = 0; opts.maxDepth === undefined || i < opts.maxDepth; i += 1) {
    const resolved = resolveAtDir(current);
    if (resolved !== null && resolved !== undefined) {
      return resolved;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function hasGitMarker(repoRoot: string): boolean {
  const gitPath = path.join(repoRoot, ".git");
  try {
    const stat = fs.statSync(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

export function findGitRoot(startDir: string, opts: { maxDepth?: number } = {}): string | null {
  // A `.git` file counts as a repo marker even if it is not a valid gitdir pointer.
  return walkUpFrom(startDir, opts, (repoRoot) => (hasGitMarker(repoRoot) ? repoRoot : null));
}

function resolveGitDirFromMarker(repoRoot: string): string | null {
  const gitPath = path.join(repoRoot, ".git");
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      return gitPath;
    }
    if (!stat.isFile()) {
      return null;
    }
    const raw = fs.readFileSync(gitPath, "utf-8");
    const match = raw.match(/gitdir:\s*(.+)/i);
    if (!match?.[1]) {
      return null;
    }
    return path.resolve(repoRoot, match[1].trim());
  } catch {
    return null;
  }
}

function resolveGitHeadPath(startDir: string, opts: { maxDepth?: number } = {}): string | null {
  // Stricter than findGitRoot: keep walking until a resolvable git dir is found.
  return walkUpFrom(startDir, opts, (repoRoot) => {
    const gitDir = resolveGitDirFromMarker(repoRoot);
    return gitDir ? path.join(gitDir, "HEAD") : null;
  });
}

/** Read at most `limit` bytes from Git or build metadata. */
export function readGitMetadataPrefix(filePath: string, limit = 256): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(limit);
    const bytesRead = readFileWindowFullySync(fd, buf, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

export function readGitHead(
  startDir: string,
  opts: { maxDepth?: number } = {},
): { headPath: string; ref: string | null; value: string | null; refsBase?: string } | undefined {
  const headPath = resolveGitHeadPath(startDir, opts);
  if (!headPath) {
    return undefined;
  }
  const head = fs.readFileSync(headPath, "utf-8").trim();
  if (!head.startsWith("ref:")) {
    return { headPath, ref: null, value: head || null };
  }
  const ref = head.replace(/^ref:\s*/i, "").trim();
  const refsBase = resolveGitRefsBase(headPath);
  return { headPath, ref, value: readGitRefs(refsBase, [ref]).get(ref) ?? null, refsBase };
}

export function resolveGitRefsBase(headPath: string): string {
  const gitDir = path.dirname(headPath);
  try {
    const commonDir = readGitMetadataPrefix(path.join(gitDir, "commondir")).trim();
    if (commonDir) {
      return path.resolve(gitDir, commonDir);
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    // Plain repo git dirs do not have commondir.
  }
  return gitDir;
}

/** Raw ref contents, sharing one packed inventory across the requested names. */
export function readGitRefs(refsBase: string, refs: readonly string[]): Map<string, string | null> {
  const values = new Map<string, string | null>(refs.map((ref) => [ref, null]));
  const missing = new Set<string>();
  for (const ref of refs) {
    const refPath = resolveRefPath(refsBase, ref);
    if (!refPath) {
      continue;
    }
    try {
      values.set(ref, readGitMetadataPrefix(refPath).trim());
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      missing.add(ref);
    }
  }
  if (missing.size === 0) {
    return values;
  }
  try {
    const packedRefs = fs.readFileSync(path.join(refsBase, "packed-refs"), "utf-8");
    for (const line of packedRefs.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) {
        continue;
      }
      const [value, packedRef] = line.trim().split(/\s+/, 2);
      if (packedRef && missing.delete(packedRef)) {
        values.set(packedRef, value ?? null);
      }
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  return values;
}

/** Safely resolve a Git ref path, rejecting traversal from a crafted HEAD file. */
function resolveRefPath(refsBase: string, ref: string): string | null {
  if (!ref.startsWith("refs/")) {
    return null;
  }
  if (path.isAbsolute(ref)) {
    return null;
  }
  if (ref.split(/[/]/).includes("..")) {
    return null;
  }
  const resolved = path.resolve(refsBase, ref);
  const rel = path.relative(refsBase, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}
