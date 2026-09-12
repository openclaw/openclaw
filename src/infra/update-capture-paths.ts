// Retained raw update artifacts never enter sanitized backup or support exports.
import fs from "node:fs";
import path from "node:path";
import { openRootFileSync, readFileDescriptorBoundedSync } from "./boundary-file-read.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import { isPathInside } from "./path-guards.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";

const MARKER_BYTES = Buffer.from(UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT);

function hasPrivacyMarker(directory: string): boolean {
  const markerPath = path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER);
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(markerPath, { bigint: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
      return false;
    }
    throw new Error("Private update capture marker is unreadable; export refused.", {
      cause: error,
    });
  }
  try {
    if (!before.isFile()) {
      throw new Error("Marker must be a regular file");
    }
    const canonicalDirectory = resolvePathViaExistingAncestorSync(directory);
    const opened = openRootFileSync({
      absolutePath: path.join(canonicalDirectory, UPDATE_CAPTURE_PRIVACY_MARKER),
      rootPath: canonicalDirectory,
      boundaryLabel: "private update capture marker",
      maxBytes: MARKER_BYTES.length,
    });
    if (!opened.ok) {
      throw new Error("Marker cannot be safely opened", { cause: opened.error });
    }
    try {
      const bytes = readFileDescriptorBoundedSync(opened.fd, MARKER_BYTES.length);
      const after = fs.fstatSync(opened.fd, { bigint: true });
      const current = fs.lstatSync(markerPath, { bigint: true });
      if (
        !bytes.equals(MARKER_BYTES) ||
        !current.isFile() ||
        !sameFileMutationFingerprint(before, after) ||
        !sameFileMutationFingerprint(after, current)
      ) {
        throw new Error("Marker is invalid or changed during read");
      }
    } finally {
      fs.closeSync(opened.fd);
    }
    return true;
  } catch (error) {
    throw new Error("Private update capture marker is invalid or unreadable; export refused.", {
      cause: error,
    });
  }
}

function isMarkedCapturePath(candidate: string): boolean {
  // Only selected ancestors. Never parse workspace manifests or enumerate roots.
  let marked = false;
  for (let ancestor = candidate; ; ancestor = path.dirname(ancestor)) {
    if (hasPrivacyMarker(ancestor)) {
      marked = true;
    }
    if (path.dirname(ancestor) === ancestor) {
      return marked;
    }
  }
}

const CAPTURE_SUFFIX = ".update-captures";

export function resolveUpdateCaptureRoot(stateDir: string): string {
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
  // A valid child marker or legacy root must not hide a malformed ancestor.
  // Evaluate both alias spellings before any exclusion can short-circuit.
  const marked = isMarkedCapturePath(candidate);
  const canonicalMarked = canonical !== candidate && isMarkedCapturePath(canonical);
  const isSelectedStateCapture = [...roots].some((root) => {
    const resolvedRoot = resolvePathViaExistingAncestorSync(root);
    return [root, resolvedRoot].some(
      (boundary) => isPathInside(boundary, candidate) || isPathInside(boundary, canonical),
    );
  });
  return (
    marked ||
    canonicalMarked ||
    isSelectedStateCapture ||
    isPairedCapturePath(candidate) ||
    isPairedCapturePath(canonical)
  );
}

export function assertNotUpdateCapturePath(sourcePath: string, stateDir: string): void {
  if (isUpdateCapturePath(sourcePath, stateDir)) {
    throw new Error("Private update captures are excluded from backups and support exports.");
  }
}
