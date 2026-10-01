import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import type { startWorkerOwnedSqliteStagingToken } from "../infra/sqlite-snapshot-staging-owner.js";
import { SQLITE_STAGING_TOKEN_FILES } from "../infra/sqlite-staging-token.js";
import { runInPluginSourceCaptureContext } from "./plugin-source-capture-context.js";
import {
  isLegacyPluginSourceCaptureName,
  PLUGIN_SOURCE_CAPTURE_PREFIX,
  resolvePluginSourceCaptureFallbackPrefix,
  resolvePluginSourceCapturesDirectory,
} from "./plugin-source-capture-path.js";

export const CAPTURE_GRACE_MS = 60 * 60 * 1_000;

export type PendingPluginSourceCaptureReclamation = {
  scanKey: string;
  close: () => Promise<void>;
};

type NativeCaptureMaintenance = {
  retainedPaths: ReadonlySet<string>;
  assertCurrent: () => void;
  removed: string[];
  startup?: boolean;
};
/** Reclamation consumes the capture owner's existing custody and maintenance records. */
export function createPluginSourceCaptureMaintenance(state: {
  ownedRoots: Set<string>;
  nativeReferences: ReadonlyMap<string, unknown>;
  retiringNativeRoots: Set<string>;
  retainLoadedPluginSourceCapture: (root: string) => boolean;
  sweeps: Map<string, Promise<void>>;
  warningBackoff: Map<string, { next: number; delay: number }>;
  pendingReclamations: Map<string, PendingPluginSourceCaptureReclamation>;
  warn: (error: unknown) => void;
}) {
  const {
    ownedRoots,
    nativeReferences,
    retiringNativeRoots,
    retainLoadedPluginSourceCapture,
    sweeps,
    warningBackoff,
    pendingReclamations,
    warn,
  } = state;
  /** Reclamation owns an existing native token until its captured payload is gone. */
  async function reclaimInstance(
    directory: string,
    originalDirectory: fs.Stats,
    scanKey: string,
    startToken: typeof startWorkerOwnedSqliteStagingToken,
    nativeMaintenance?: NativeCaptureMaintenance,
  ): Promise<void> {
    const ownerPath = path.join(directory, SQLITE_STAGING_TOKEN_FILES[0]);
    const family = SQLITE_STAGING_TOKEN_FILES.map((file) =>
      fs.lstatSync(path.join(directory, file), { throwIfNoEntry: false }),
    );
    const originalOwner = family[0];
    const captures = path.join(directory, "captures");
    const captured = fs.lstatSync(captures, { throwIfNoEntry: false });
    if (
      (process.getuid && originalDirectory.uid !== process.getuid()) ||
      !originalOwner ||
      family.some(
        (file) =>
          file &&
          (!file.isFile() || file.nlink !== 1 || (process.getuid && file.uid !== process.getuid())),
      ) ||
      (captured && !captured.isDirectory())
    ) {
      return;
    }
    const unchanged = () => {
      const currentDirectory = fs.lstatSync(directory);
      const currentOwner = fs.lstatSync(ownerPath);
      return (
        currentDirectory.dev === originalDirectory.dev &&
        currentDirectory.ino === originalDirectory.ino &&
        currentDirectory.isDirectory() &&
        currentOwner.isFile() &&
        currentOwner.nlink === 1 &&
        currentOwner.dev === originalOwner.dev &&
        currentOwner.ino === originalOwner.ino
      );
    };
    // Reclaim refuses a missing token and never creates a replacement ownership database.
    const admission = startToken(directory, "reclaim");
    const admissionCleanup = { scanKey, close: () => admission.startClose().result };
    const release = await admission.result.catch(async (error: unknown) => {
      try {
        await admissionCleanup.close();
      } catch (cleanupError) {
        pendingReclamations.set(directory, admissionCleanup);
        ownedRoots.add(directory);
        throw createSqliteLifecycleAggregateError(
          [error, cleanupError],
          "Plugin source reclamation admission cleanup failed",
          error,
        );
      }
      throw error;
    });
    const assertReclaimCurrent = () => {
      if (!release.isCurrent()) {
        throw new Error("Plugin source reclamation lost its original writer");
      }
    };
    let released = false;
    const errors: unknown[] = [];
    ownedRoots.add(directory);
    try {
      assertReclaimCurrent();
      if (!unchanged()) {
        return;
      }
      const native = path.join(directory, "native");
      // A producer can publish native bytes between inspection and exclusive admission.
      const nativeStat = fs.lstatSync(native, { throwIfNoEntry: false });
      assertReclaimCurrent();
      if (!unchanged()) {
        return;
      }
      await fsPromises.rm(captures, { recursive: true, force: true });
      assertReclaimCurrent();
      let retainedNative = Boolean(nativeStat);
      if (nativeStat?.isDirectory() && nativeMaintenance) {
        for (const nativeEntry of await fsPromises.readdir(native, { withFileTypes: true })) {
          const nativeDirectory = path.join(native, nativeEntry.name);
          if (!nativeEntry.isDirectory()) {
            continue;
          }
          nativeMaintenance.assertCurrent();
          assertReclaimCurrent();
          if (!unchanged()) {
            return;
          }
          const contained = (file: string) => file.startsWith(nativeDirectory + path.sep);
          if (
            [...nativeMaintenance.retainedPaths].some(contained) ||
            [...nativeReferences.keys()].some(contained)
          ) {
            continue;
          }
          retiringNativeRoots.add(nativeDirectory);
          try {
            assertReclaimCurrent();
            if (!unchanged()) {
              return;
            }
            await fsPromises.rm(nativeDirectory, { recursive: true, force: true });
            assertReclaimCurrent();
            nativeMaintenance.removed.push(nativeDirectory);
          } finally {
            retiringNativeRoots.delete(nativeDirectory);
          }
        }
        retainedNative = (await fsPromises.readdir(native)).length > 0;
        assertReclaimCurrent();
      }
      // Retirement closes staging admission; committed native readers use receipt-bound files.
      assertReclaimCurrent();
      if (!unchanged()) {
        return;
      }
      await release.retire();
      released = true;
      // The shipped instance ID is never reused. Windows requires closing before unlink.
      if (!retainedNative && unchanged()) {
        nativeMaintenance?.assertCurrent();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        if (!released) {
          await release.close();
        }
      } catch (error) {
        pendingReclamations.set(directory, { scanKey, close: () => release.close() });
        errors.push(error);
      } finally {
        if (!pendingReclamations.has(directory)) {
          ownedRoots.delete(directory);
        }
      }
      throwSqliteLifecycleErrors(errors, "Plugin source reclamation and cleanup failed");
    }
  }

  async function reclaimInstances(
    root: string,
    recordFailure: (error: unknown) => void,
    legacy = false,
    nativeMaintenance?: NativeCaptureMaintenance,
    fallbackPrefix?: string,
  ): Promise<void> {
    const scanKey = JSON.stringify([root, legacy, fallbackPrefix]);
    // Retry original non-destructive custody before inspecting paths for a fresh admission.
    for (const [directory, pending] of Array.from(pendingReclamations)) {
      if (pending.scanKey !== scanKey) {
        continue;
      }
      try {
        await pending.close();
        if (pendingReclamations.get(directory) === pending) {
          pendingReclamations.delete(directory);
          ownedRoots.delete(directory);
        }
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT") && !isSqliteLockError(error)) {
          recordFailure(error);
        }
      }
    }
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      return;
    }
    if (entries.length === 0) {
      return;
    }
    const cutoff = Date.now() - CAPTURE_GRACE_MS;
    let legacyAllowed: boolean | undefined;
    const lstatIfPresent = (file: string) =>
      fsPromises.lstat(file).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        return undefined;
      });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        (legacy && !isLegacyPluginSourceCaptureName(entry.name)) ||
        (fallbackPrefix && !entry.name.startsWith(fallbackPrefix))
      ) {
        continue;
      }
      const directory = path.join(root, entry.name);
      try {
        const { startWorkerOwnedSqliteStagingToken } = await runInPluginSourceCaptureContext(
          () => import("../infra/sqlite-snapshot-staging-owner.js"),
        );
        const stat = await fsPromises.lstat(directory);
        const changed = legacy
          ? Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs)
          : stat.mtimeMs;
        if (!stat.isDirectory() || (changed > cutoff && !nativeMaintenance?.startup)) {
          continue;
        }
        const canonical = await fsPromises.realpath(directory);
        // Opening/closing a second native connection can disturb this process's POSIX locks.
        if (ownedRoots.has(canonical) || retainLoadedPluginSourceCapture(canonical)) {
          continue;
        }
        const tokenPath = path.join(canonical, SQLITE_STAGING_TOKEN_FILES[0]);
        const nativeStat = await lstatIfPresent(path.join(canonical, "native"));
        const tokenStat = await lstatIfPresent(tokenPath);
        if (legacy && tokenStat) {
          continue;
        }
        if (!tokenStat) {
          // A qualified name selects the state; only its token proves released custody.
          if (fallbackPrefix || changed > cutoff) {
            continue;
          }
          // Native payload may already be published; missing custody cannot authorize removal.
          if (nativeStat) {
            continue;
          }
          if (legacy) {
            if (legacyAllowed === undefined) {
              const { inspectOtherOpenClawProcesses } =
                await import("../infra/openclaw-process-census.js");
              const census = inspectOtherOpenClawProcesses();
              legacyAllowed = "error" in census || census.pids.length === 0;
            }
            if (!legacyAllowed) {
              continue;
            }
            // The census excludes foreign-UID processes, not their scratch. Recheck
            // ownership after inspection, even when an elevated process could remove it.
            if (process.getuid && (await fsPromises.lstat(canonical)).uid !== process.getuid()) {
              continue;
            }
          }
          // Legacy writers have no token. Probe for Windows sharing violations before
          // removing aged scratch; retain the recognizable name if removal is interrupted.
          const retired = path.join(
            root,
            `${legacy ? PLUGIN_SOURCE_CAPTURE_PREFIX : ""}${randomUUID()}`,
          );
          await fsPromises.rename(canonical, retired);
          await fsPromises.rm(retired, { recursive: true, force: true });
          continue;
        }
        await reclaimInstance(
          canonical,
          stat,
          scanKey,
          startWorkerOwnedSqliteStagingToken,
          nativeMaintenance,
        );
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT") && !isSqliteLockError(error)) {
          recordFailure(error);
        }
      }
    }
  }

  /** The caller holds database maintenance and supplies a fresh installed-index reference set. */
  async function prunePluginNativeCaptureDirectories(
    stateDir: string,
    retainedPaths: ReadonlySet<string>,
    assertCurrent: () => void,
    options: { startup?: boolean } = {},
  ) {
    const removed: string[] = [];
    const warnings: string[] = [];
    assertCurrent();
    const recordFailure = (error: unknown) => warnings.push(formatErrorMessage(error));
    const maintenance = { retainedPaths, assertCurrent, removed, ...options };
    await reclaimInstances(
      path.resolve(resolvePluginSourceCapturesDirectory(stateDir)),
      recordFailure,
      false,
      maintenance,
    ).catch(recordFailure);
    await reclaimInstances(
      tmpdir(),
      recordFailure,
      false,
      maintenance,
      resolvePluginSourceCaptureFallbackPrefix(stateDir),
    ).catch(recordFailure);
    return { removed, warnings };
  }

  /** Coalesce active scans, but throttle diagnostics independently of cleanup retries. */
  function sweepPluginSourceCaptureDirectories(stateDir: string): Promise<void> {
    const root = path.resolve(resolvePluginSourceCapturesDirectory(stateDir));
    let sweep = sweeps.get(root);
    if (!sweep) {
      let failures = 0;
      let firstFailure: unknown;
      const recordFailure = (error: unknown) => {
        if (failures++ === 0) {
          firstFailure = error;
        }
      };
      sweep = reclaimInstances(root, recordFailure)
        .catch(recordFailure)
        .then(() =>
          reclaimInstances(
            tmpdir(),
            recordFailure,
            false,
            undefined,
            resolvePluginSourceCaptureFallbackPrefix(stateDir),
          ),
        )
        .catch(recordFailure)
        .then(async () => {
          const visited = new Set<string>();
          for (const candidate of [path.join(stateDir, "tmp"), tmpdir()]) {
            try {
              const directory = await fsPromises.realpath(candidate);
              if (!visited.has(directory)) {
                visited.add(directory);
                await reclaimInstances(directory, recordFailure, true);
              }
            } catch (error) {
              if (!hasErrnoCode(error, "ENOENT")) {
                recordFailure(error);
              }
            }
          }
        })
        .then(() => {
          if (failures === 0) {
            warningBackoff.delete(root);
            return;
          }
          const now = Date.now();
          const previous = warningBackoff.get(root);
          if (previous && now < previous.next) {
            return;
          }
          const delay = Math.min(
            (previous?.delay ?? CAPTURE_GRACE_MS / 2) * 2,
            24 * CAPTURE_GRACE_MS,
          );
          // Bound diagnostics for processes that inspect many independent profiles.
          if (!previous && warningBackoff.size >= 32) {
            const oldest = warningBackoff.keys().next().value;
            if (oldest !== undefined) {
              warningBackoff.delete(oldest);
            }
          }
          warningBackoff.set(root, { next: now + delay, delay });
          warn(
            `${failures} cleanup failure(s) in ${root}; will retry. First: ${formatErrorMessage(firstFailure)}`,
          );
        })
        .finally(() => sweeps.delete(root));
      sweeps.set(root, sweep);
    }
    return sweep;
  }

  return { prunePluginNativeCaptureDirectories, sweepPluginSourceCaptureDirectories };
}
