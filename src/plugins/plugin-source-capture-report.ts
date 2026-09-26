import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { walkDirectory } from "../infra/fs-safe.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import { isLegacyPluginSourceCaptureName } from "./plugin-source-capture-path.js";

type LegacyCapture = {
  path: string;
  bytes: number;
  identity: Stats;
  changedAtMs: number;
  complete: boolean;
};

async function readLegacyCapture(directory: string): Promise<Stats | undefined> {
  const identity = await fs.lstat(directory);
  if (!identity.isDirectory()) {
    return undefined;
  }
  try {
    await fs.lstat(path.join(directory, "owner.sqlite"));
    return undefined;
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return identity;
  }
}

async function inspectLegacyCapture(
  directory: string,
  warn: (file: string, error: unknown) => void,
): Promise<LegacyCapture | undefined> {
  const identity = await readLegacyCapture(directory);
  if (!identity) {
    return undefined;
  }
  const scan = await walkDirectory(directory, { symlinks: "include" });
  let complete = scan.failedDirs.length === 0;
  for (const failure of scan.failedDirs) {
    warn(failure.path, failure.error);
  }
  let bytes = 0;
  let changedAtMs = Math.max(identity.birthtimeMs, identity.ctimeMs);
  for (const entry of scan.entries) {
    try {
      const stat = await fs.lstat(entry.path);
      changedAtMs = Math.max(changedAtMs, stat.birthtimeMs, stat.ctimeMs);
      if (stat.isFile()) {
        bytes += stat.size;
      }
    } catch (error) {
      complete = false;
      warn(entry.path, error);
    }
  }
  return { path: directory, bytes, identity, changedAtMs, complete };
}

/** Legacy captures span old service environments as well as the selected state. */
export async function inspectLegacyPluginSourceCaptureRoots(
  stateDir: string,
  temporaryDirectories: readonly string[] = [],
) {
  const directories = new Set<string>();
  const roots: LegacyCapture[] = [];
  const warnings: string[] = [];
  const warn = (file: string, error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      warnings.push(`Could not inspect ${file}: ${String(error)}`);
    }
  };
  for (const candidate of [
    path.join(stateDir, "tmp"),
    tmpdir(),
    ...(process.platform === "win32" ? [] : ["/tmp"]),
    ...temporaryDirectories,
  ]) {
    try {
      // /tmp itself is a symlink on macOS. Resolve selected roots once and deduplicate aliases;
      // the walker never follows links inside those roots or their capture directories.
      const directory = await fs.realpath(candidate);
      if (directories.has(directory)) {
        continue;
      }
      directories.add(directory);
      const candidates = await walkDirectory(directory, {
        maxDepth: 1,
        symlinks: "skip",
        include: (entry) =>
          entry.kind === "directory" && isLegacyPluginSourceCaptureName(entry.name),
      });
      for (const failure of candidates.failedDirs) {
        warn(failure.path, failure.error);
      }
      for (const entry of candidates.entries) {
        try {
          const capture = await inspectLegacyCapture(entry.path, warn);
          if (capture) {
            roots.push(capture);
          }
        } catch (error) {
          warn(entry.path, error);
        }
      }
    } catch (error) {
      warn(candidate, error);
    }
  }
  roots.sort((left, right) => left.path.localeCompare(right.path));
  return {
    roots,
    totalBytes: roots.reduce((bytes, root) => bytes + root.bytes, 0),
    warnings,
  };
}

/** The Doctor owner must retain maintenance and recheck the host census before each removal. */
export async function pruneLegacyPluginSourceCaptures(
  report: Awaited<ReturnType<typeof inspectLegacyPluginSourceCaptureRoots>>,
  assertCurrent: () => void,
) {
  const removed: LegacyCapture[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const warnings: string[] = [];
  let blockedReason: string | undefined;
  const mayProceed = () => {
    try {
      assertCurrent();
      return true;
    } catch (error) {
      blockedReason = String(error);
      return false;
    }
  };
  if (mayProceed()) {
    for (const root of report.roots) {
      try {
        const current = await inspectLegacyCapture(root.path, (file, error) => {
          warnings.push(`Could not inspect ${file}: ${String(error)}`);
        });
        if (
          !current ||
          current.identity.dev !== root.identity.dev ||
          current.identity.ino !== root.identity.ino
        ) {
          skipped.push({ path: root.path, reason: "capture identity or custody changed" });
          continue;
        }
        if (!current.complete) {
          skipped.push({ path: root.path, reason: "capture inspection is incomplete" });
          continue;
        }
        if (current.changedAtMs >= performance.timeOrigin) {
          skipped.push({
            path: root.path,
            reason: "created or changed during the current process",
          });
          continue;
        }
        if (!mayProceed()) {
          break;
        }
        await removeTemporaryArtifacts(root.path, "Legacy plugin capture");
        const remaining = await fs.lstat(root.path).catch((error: unknown) => {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
          return undefined;
        });
        if (remaining) {
          warnings.push(`Could not remove ${root.path}; see the capture cleanup warning.`);
        } else {
          removed.push(current);
        }
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          warnings.push(`Could not reclaim ${root.path}: ${String(error)}`);
        }
      }
    }
  }
  return { removed, skipped, warnings, blockedReason };
}
