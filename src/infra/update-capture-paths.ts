// Retained raw update artifacts never enter sanitized backup or support exports.
import fs from "node:fs";
import path from "node:path";
import { openRootFileSync, readFileDescriptorBoundedSync } from "./boundary-file-read.js";
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

type CapturePath = { path: string; directory: boolean };

function resolveCapturePath(
  sourcePath: string,
  entries = new Map<string, boolean>(),
): CapturePath | undefined {
  const activeLinks = new Set<string>();
  function resolve(
    candidate: string,
    inspected: Map<string, boolean>,
    depth: number,
  ): CapturePath | undefined {
    const root = path.parse(candidate).root;
    let current: CapturePath = { path: root, directory: true };
    inspected.set(root, true);
    const separators = path.sep === "\\" ? /[\\/]/ : /\//;
    for (const component of candidate.slice(root.length).split(separators)) {
      if (!current.directory) {
        return undefined;
      }
      const entry = path.resolve(current.path, component);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(entry);
      } catch (error) {
        if (
          hasErrnoCode(error, "ENOENT") ||
          hasErrnoCode(error, "ENOTDIR") ||
          hasErrnoCode(error, "ELOOP")
        ) {
          return undefined;
        }
        throw new Error("Private update capture marker is unreadable; export refused.", {
          cause: error,
        });
      }
      if (stat.isSymbolicLink()) {
        inspected.set(entry, false);
        if (activeLinks.has(entry) || depth === 40) {
          return undefined;
        }
        activeLinks.add(entry);
        const link = fs.readlinkSync(entry);
        const targetEntries = new Map<string, boolean>();
        // Keep target components in filesystem order: an earlier link changes what '..' means.
        const target = resolve(
          path.isAbsolute(link) ? link : current.path + path.sep + link,
          targetEntries,
          depth + 1,
        );
        activeLinks.delete(entry);
        if (!target) {
          return undefined;
        }
        for (const [targetPath, realDirectory] of targetEntries) {
          inspected.set(targetPath, realDirectory);
        }
        current = target;
      } else {
        current = { path: entry, directory: stat.isDirectory() };
        inspected.set(entry, current.directory);
      }
    }
    return current;
  }
  return resolve(
    path.isAbsolute(sourcePath) ? sourcePath : process.cwd() + path.sep + sourcePath,
    entries,
    0,
  );
}

function isPairedCapturePath(directory: string): boolean {
  const name = path.basename(directory);
  return (
    name.length > CAPTURE_SUFFIX.length &&
    name.endsWith(CAPTURE_SUFFIX) &&
    resolveCapturePath(directory.slice(0, -CAPTURE_SUFFIX.length))?.directory === true
  );
}

/** One admission decision over real ancestors and safely resolved link targets. */
export function isUpdateCapturePath(sourcePath: string, stateDir: string): boolean {
  const entries = new Map<string, boolean>();
  resolveCapturePath(sourcePath, entries);
  const captureRoot = resolveUpdateCaptureRoot(stateDir);
  const resolvedRoot = resolveCapturePath(captureRoot)?.path;
  let captured = false;
  for (const [entryPath, realDirectory] of entries) {
    // Logical names establish legacy ownership; only real directories can carry markers.
    if (realDirectory) {
      captured = hasPrivacyMarker(entryPath) || captured;
    }
    captured =
      entryPath === captureRoot ||
      entryPath === resolvedRoot ||
      isPairedCapturePath(entryPath) ||
      captured;
  }
  return captured;
}

export function assertNotUpdateCapturePath(sourcePath: string, stateDir: string): void {
  if (isUpdateCapturePath(sourcePath, stateDir)) {
    throw new Error("Private update captures are excluded from backups and support exports.");
  }
}
