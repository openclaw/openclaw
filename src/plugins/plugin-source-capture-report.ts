import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode } from "../infra/errno.js";
import { walkDirectory } from "../infra/fs-safe.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "./installed-plugin-index-store-path.js";
import { parseInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { readPluginMetadataStateRow } from "./plugin-metadata-state-worker.js";
import { prunePluginNativeCaptureDirectories } from "./plugin-source-capture-directory.js";
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

/** Durable native payload is reclaimed only against current receipts under maintenance. */
export async function pruneUnreferencedPluginNativeCaptures(
  stateDir: string,
  assertCurrent: () => void,
  env?: NodeJS.ProcessEnv,
  options: { startup?: boolean } = {},
) {
  try {
    assertCurrent();
    const row = await readPluginMetadataStateRow(
      "installed-index",
      resolveInstalledPluginIndexStateDatabaseOptions({ stateDir, env }),
    );
    assertCurrent();
    const retainedPaths = new Set<string>();
    if (row) {
      const payload: unknown = JSON.parse(row.value_json);
      const rawIndex = isRecord(payload) ? payload.index : undefined;
      const index = parseInstalledPluginIndex(rawIndex);
      if (!index || !isRecord(rawIndex) || !Array.isArray(rawIndex.plugins)) {
        throw new Error("Installed plugin index is invalid; native captures were preserved.");
      }
      for (const [position, plugin] of index.plugins.entries()) {
        const rawPlugin: unknown = rawIndex.plugins[position];
        if (
          isRecord(rawPlugin) &&
          rawPlugin.sourceAdmissions !== undefined &&
          !plugin.sourceAdmissions
        ) {
          throw new Error("Plugin native admission receipts are invalid; captures were preserved.");
        }
        for (const receipt of Object.values(plugin.sourceAdmissions ?? {})) {
          for (const namespace of Object.values(receipt.nativeNamespaces)) {
            retainedPaths.add(path.join(path.resolve(namespace.capturedRoot), "content"));
          }
          for (const artifact of Object.values(receipt.nativeArtifacts)) {
            retainedPaths.add(path.resolve(artifact.capturedPath));
          }
        }
      }
    }
    return await prunePluginNativeCaptureDirectories(
      stateDir,
      retainedPaths,
      assertCurrent,
      options,
    );
  } catch (error) {
    return { removed: [], warnings: [`Native capture cleanup skipped: ${String(error)}`] };
  }
}
