// Retained raw update artifacts never enter sanitized backup or support exports.
import fs from "node:fs";
import path from "node:path";
import { openRootFileSync, readFileDescriptorBoundedSync } from "./boundary-file-read.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
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
    const opened = openRootFileSync({
      absolutePath: markerPath,
      rootPath: directory,
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

const CAPTURE_SUFFIX = ".update-captures";

export function resolveUpdateCaptureRoot(stateDir: string): string {
  return `${path.resolve(stateDir)}${CAPTURE_SUFFIX}`;
}

function isPairedCapturePath(directory: string): boolean {
  const name = path.basename(directory);
  if (name.length <= CAPTURE_SUFFIX.length || !name.endsWith(CAPTURE_SUFFIX)) {
    return false;
  }
  try {
    return fs.lstatSync(directory.slice(0, -CAPTURE_SUFFIX.length)).isDirectory();
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

/** Inspect real ancestors up to the first link; link targets are separate source selections. */
export function isUpdateCapturePath(sourcePath: string, stateDir: string): boolean {
  const ancestors: string[] = [];
  for (let ancestor = path.resolve(sourcePath); ; ancestor = path.dirname(ancestor)) {
    ancestors.push(ancestor);
    if (path.dirname(ancestor) === ancestor) {
      break;
    }
  }
  const captureRoot = resolveUpdateCaptureRoot(stateDir);
  let captured = false;
  for (const ancestor of ancestors.toReversed()) {
    try {
      if (!fs.lstatSync(ancestor).isDirectory()) {
        return captured;
      }
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
        return captured;
      }
      throw new Error("Private update capture marker is unreadable; export refused.", {
        cause: error,
      });
    }
    // Inspect every real marker even after an earlier ancestor excludes the source.
    captured = hasPrivacyMarker(ancestor) || captured;
    captured = ancestor === captureRoot || isPairedCapturePath(ancestor) || captured;
  }
  return captured;
}

/** Admit selected file contents, including the actual read path; not ordinary link entries. */
export function assertNotUpdateCapturePath(sourcePath: string, stateDir: string): void {
  const selectedPrivate = isUpdateCapturePath(sourcePath, stateDir);
  const readPath = resolvePathViaExistingAncestorSync(sourcePath);
  const readPrivate = readPath !== sourcePath && isUpdateCapturePath(readPath, stateDir);
  if (selectedPrivate || readPrivate) {
    throw new Error("Private update captures are excluded from backups and support exports.");
  }
}
