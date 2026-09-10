// Retained raw update artifacts never enter sanitized backup or support exports.
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { isPathInside } from "./path-guards.js";

function resolveUpdateCaptureRoot(stateDir: string): string {
  return `${path.resolve(stateDir)}.update-captures`;
}

/** Exact managed roots, not a basename filter that hides unrelated workspace files. */
export function isUpdateCapturePath(sourcePath: string, stateDir: string): boolean {
  const roots = new Set([
    resolveUpdateCaptureRoot(stateDir),
    resolveUpdateCaptureRoot(resolvePathViaExistingAncestorSync(stateDir)),
  ]);
  const candidate = path.resolve(sourcePath);
  const canonical = resolvePathViaExistingAncestorSync(sourcePath);
  return [...roots].some((root) => {
    const resolvedRoot = resolvePathViaExistingAncestorSync(root);
    return [root, resolvedRoot].some(
      (boundary) => isPathInside(boundary, candidate) || isPathInside(boundary, canonical),
    );
  });
}

export function assertNotUpdateCapturePath(sourcePath: string, stateDir: string): void {
  if (isUpdateCapturePath(sourcePath, stateDir)) {
    throw new Error("Private update captures are excluded from backups and support exports.");
  }
}
