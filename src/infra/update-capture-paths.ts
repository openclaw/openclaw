// Retained raw update artifacts never enter sanitized backup or support exports.
import fs from "node:fs";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import { isPathInside } from "./path-guards.js";

const CAPTURE_SUFFIX = ".update-captures";

function resolveUpdateCaptureRoot(stateDir: string): string {
  return `${path.resolve(stateDir)}${CAPTURE_SUFFIX}`;
}

function isPairedCapturePath(candidate: string): boolean {
  // Only inspect the selected path's ancestors, not other profiles or a global registry.
  // The sibling directory anchors the reserved layout; it is not writer authority.
  for (
    let ancestor = candidate;
    path.dirname(ancestor) !== ancestor;
    ancestor = path.dirname(ancestor)
  ) {
    const name = path.basename(ancestor);
    if (name.length <= CAPTURE_SUFFIX.length || !name.endsWith(CAPTURE_SUFFIX)) {
      continue;
    }
    try {
      if (fs.statSync(ancestor.slice(0, -CAPTURE_SUFFIX.length)).isDirectory()) {
        return true;
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
        throw error;
      }
    }
  }
  return false;
}

/** Exact managed roots, not a basename filter that hides unrelated workspace files. */
export function isUpdateCapturePath(sourcePath: string, stateDir: string): boolean {
  const roots = new Set([
    resolveUpdateCaptureRoot(stateDir),
    resolveUpdateCaptureRoot(resolvePathViaExistingAncestorSync(stateDir)),
  ]);
  const candidate = path.resolve(sourcePath);
  const canonical = resolvePathViaExistingAncestorSync(sourcePath);
  const isSelectedStateCapture = [...roots].some((root) => {
    const resolvedRoot = resolvePathViaExistingAncestorSync(root);
    return [root, resolvedRoot].some(
      (boundary) => isPathInside(boundary, candidate) || isPathInside(boundary, canonical),
    );
  });
  return isSelectedStateCapture || isPairedCapturePath(candidate) || isPairedCapturePath(canonical);
}

export function assertNotUpdateCapturePath(sourcePath: string, stateDir: string): void {
  if (isUpdateCapturePath(sourcePath, stateDir)) {
    throw new Error("Private update captures are excluded from backups and support exports.");
  }
}
