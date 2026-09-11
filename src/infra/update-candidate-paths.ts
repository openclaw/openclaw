import path from "node:path";
import { sha256Hex } from "./crypto-digest.js";
import { isPathInside, normalizeWindowsPathPreservingCase } from "./path-guards.js";

// Keep path projection independent of snapshot orchestration: the snapshot owner
// dynamically loads plugin projection, so importing it back creates a worker build cycle.
/** Shared with config projection so custom agent directories use their copied database. */
export function resolveUpdateCandidateStatePath(
  sourceRoot: string,
  targetRoot: string,
  source: string,
): string {
  // Extended-length \\?\ spellings name the same files as their plain
  // counterparts, but path.relative cannot see across the namespace prefix: it
  // returns the absolute source unchanged, and joining that under the target
  // root would embed the prefix mid-path. Rebase through the case-preserving
  // plain spelling so namespaced registered paths project like any other.
  const projectionRoot =
    process.platform === "win32" ? normalizeWindowsPathPreservingCase(sourceRoot) : sourceRoot;
  const projectionSource =
    process.platform === "win32" ? normalizeWindowsPathPreservingCase(source) : source;
  // Registered link/../ locators can identify a different inode from their
  // normalized spelling; flattening them would overwrite another copied database.
  const relative =
    path.normalize(projectionSource) === projectionSource &&
    isPathInside(projectionRoot, projectionSource)
      ? path.relative(projectionRoot, projectionSource)
      : path.join("candidate-external", sha256Hex(source));
  return path.join(targetRoot, relative);
}

/** Plugin locators cannot overwrite the separately snapshotted state databases. */
export function resolveUpdateCandidatePluginPath(
  sourceRoot: string,
  targetRoot: string,
  source: string,
): string {
  const managed = ["npm", "extensions"].some((directory) =>
    isPathInside(path.join(sourceRoot, directory), source),
  );
  return managed
    ? resolveUpdateCandidateStatePath(sourceRoot, targetRoot, source)
    : path.join(
        targetRoot,
        "candidate-plugins",
        sha256Hex(path.parse(source).root),
        path.relative(path.parse(source).root, source),
      );
}
