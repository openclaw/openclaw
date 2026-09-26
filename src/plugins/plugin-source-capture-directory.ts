import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import type { GatewayScheduler, GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import { isPathInside, normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import {
  tryAcquireExclusiveSqliteCoordinator,
  type SqliteCoordinatorLease,
} from "../infra/sqlite-coordinator.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  pluginSourceCaptureMaintenance,
  runInPluginSourceCaptureContext,
} from "./plugin-source-capture-context.js";
import {
  isLegacyPluginSourceCaptureName,
  PLUGIN_SOURCE_CAPTURE_PREFIX,
} from "./plugin-source-capture-path.js";

const CAPTURE_GRACE_MS = 60 * 60 * 1_000;
const LEASE_FILE = "owner.sqlite";
type Instance = {
  references: Set<{ scheduler: GatewayScheduler | null }>;
  pendingNative: Set<string>;
  closing?: boolean;
  scheduler?: GatewayScheduler;
  cleanupJob?: GatewayScheduledJob;
  detachScheduler?: () => void;
  root?: string;
  managedRoot?: string;
  lease?: SqliteCoordinatorLease;
};
const {
  instances,
  ownedRoots,
  nativeReferences,
  retiringNativeRoots,
  nativeLoadPaths,
  retainedRoots,
  sweeps,
  warningBackoff,
} = resolveGlobalSingleton(Symbol.for("openclaw.pluginSourceCaptureInstances"), () => {
  const observedNativePaths = new Set<string>();
  const loadAddon = process.dlopen.bind(process);
  // Node keeps main-thread addons loaded: https://github.com/nodejs/node/blob/v24.8.0/src/env.cc#L1050
  // Windows mapped-image unlink fails (access denied becomes EPERM):
  // https://github.com/libuv/libuv/blob/v1.51.0/src/win/fs.c#L1172
  // https://github.com/libuv/libuv/blob/v1.51.0/src/win/error.c#L158
  // Record before initialization: it can throw or reenter cleanup with the image already mapped.
  // Full diagnostic reports race Windows DbgHelp across workers; cleanup consumes load facts only.
  process.dlopen = (...args) => {
    try {
      const file = fs.realpathSync.native(args[1]);
      observedNativePaths.add(
        process.platform === "win32" ? normalizeWindowsPathPreservingCase(file) : file,
      );
    } catch {
      // Observation must not replace the native loader's return or original error.
    }
    return loadAddon(...args);
  };
  process.once("exit", () => {
    // Explicit exits cannot await generation disposal. These native leases belong
    // only to this exiting process; worker overrides remain with their parent.
    for (const [key, instance] of instances) {
      try {
        const root = retireInstance(key, instance);
        if (root) {
          removeInstanceSync(root, instance.pendingNative);
        }
      } catch (error) {
        process.stderr.write(`Plugin source capture exit cleanup failed: ${String(error)}\n`);
      }
    }
  });
  return {
    instances: new Map<string, Instance>(),
    ownedRoots: new Set<string>(),
    nativeReferences: new Map<string, number>(),
    retiringNativeRoots: new Set<string>(),
    nativeLoadPaths: observedNativePaths,
    retainedRoots: new Set<string>(),
    sweeps: new Map<string, Promise<void>>(),
    warningBackoff: new Map<string, { next: number; delay: number }>(),
  };
});

function retireInstance(key: string, instance: Instance): string | undefined {
  if (instance.root && retainLoadedPluginSourceCapture(instance.root)) {
    instance.references.clear();
    scheduleCaptureCleanup(key, instance);
    return undefined;
  }
  instance.closing = true;
  // Keep custody and the retryable handle if native close fails.
  instance.lease?.release();
  if (instance.root) {
    ownedRoots.delete(instance.root);
  }
  instance.references.clear();
  instances.delete(key);
  instance.cleanupJob?.cancel();
  instance.detachScheduler?.();
  return instance.root;
}

function instanceDirectory(stateDir: string): string {
  return path.join(stateDir, "tmp", "plugin-captures");
}

function warn(error: unknown) {
  process.emitWarning(`Plugin source capture cleanup: ${String(error)}`);
}

/** Physical module lifetime outlives registration and CommonJS cache eviction. */
export function retainLoadedPluginSourceCapture(directory: string): boolean {
  if (![...nativeLoadPaths].some((file) => isPathInside(directory, file))) {
    return false;
  }
  const retained = [...ownedRoots].find((root) => isPathInside(root, directory)) ?? directory;
  if (
    ![...retainedRoots].some((root) => isPathInside(root, retained) || isPathInside(retained, root))
  ) {
    warn(`retained-by-loaded-module: ${retained}; cleanup deferred until the next startup`);
  }
  retainedRoots.add(retained);
  return true;
}

function removeInstanceSync(root: string, pendingNative: Iterable<string> = []): void {
  if (retainLoadedPluginSourceCapture(root)) {
    return;
  }
  // A sharing violation must leave the coordinator beside any retained payload.
  fs.rmSync(path.join(root, "captures"), { recursive: true, force: true });
  for (const directory of pendingNative) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const native = path.join(root, "native");
  if (!fs.existsSync(native) || fs.readdirSync(native).length === 0) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function reclaimInstances(
  root: string,
  recordFailure: (error: unknown) => void,
  legacy = false,
  nativeMaintenance?: {
    retainedPaths: ReadonlySet<string>;
    assertCurrent: () => void;
    removed: string[];
    startup?: boolean;
  },
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return;
  }
  const cutoff = Date.now() - CAPTURE_GRACE_MS;
  let legacyAllowed: boolean | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || (legacy && !isLegacyPluginSourceCaptureName(entry.name))) {
      continue;
    }
    const directory = path.join(root, entry.name);
    let lease: SqliteCoordinatorLease | null = null;
    try {
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
      const leasePath = path.join(canonical, LEASE_FILE);
      const native = path.join(canonical, "native");
      const nativeStat = await fsPromises.lstat(native).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        return undefined;
      });
      const leaseStat = await fsPromises.lstat(leasePath).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        return undefined;
      });
      if (legacy && leaseStat) {
        continue;
      }
      if (!leaseStat) {
        if (changed > cutoff) {
          continue;
        }
        // A prior process may have published any native payload. Only maintenance
        // with both the installed-index references and a lease can reclaim it.
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
        }
        // Legacy writers have no lease. Probe for Windows sharing violations before
        // removing aged scratch; retain the recognizable name if removal is interrupted.
        const retired = path.join(
          root,
          `${legacy ? PLUGIN_SOURCE_CAPTURE_PREFIX : ""}${randomUUID()}`,
        );
        await fsPromises.rename(canonical, retired);
        await fsPromises.rm(retired, { recursive: true, force: true });
        continue;
      }
      const captures = path.join(canonical, "captures");
      const captureStat = await fsPromises.lstat(captures).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        // A prior pass may have removed the payload before instance removal failed.
        return undefined;
      });
      if (
        !leaseStat.isFile() ||
        leaseStat.nlink !== 1 ||
        (captureStat && !captureStat.isDirectory()) ||
        ownedRoots.has(canonical)
      ) {
        continue;
      }
      lease = tryAcquireExclusiveSqliteCoordinator(leasePath);
      if (!lease) {
        continue;
      }
      ownedRoots.add(canonical);
      try {
        // The native lock proves released custody even across PID namespaces.
        await fsPromises.rm(captures, { recursive: true, force: true });
        let retainedNative = Boolean(nativeStat);
        if (nativeStat?.isDirectory() && nativeMaintenance) {
          for (const nativeEntry of await fsPromises.readdir(native, { withFileTypes: true })) {
            const nativeDirectory = path.join(native, nativeEntry.name);
            if (!nativeEntry.isDirectory()) {
              continue;
            }
            nativeMaintenance.assertCurrent();
            const contained = (file: string) => file.startsWith(nativeDirectory + path.sep);
            if (
              [...nativeMaintenance.retainedPaths].some(contained) ||
              [...nativeReferences.keys()].some(contained)
            ) {
              continue;
            }
            retiringNativeRoots.add(nativeDirectory);
            try {
              await fsPromises.rm(nativeDirectory, { recursive: true, force: true });
              nativeMaintenance.removed.push(nativeDirectory);
            } finally {
              retiringNativeRoots.delete(nativeDirectory);
            }
          }
          retainedNative = (await fsPromises.readdir(native)).length > 0;
        }
        lease.release();
        lease = null;
        // Instance IDs are never reused. Close the lease before removing its file on Windows.
        if (!retainedNative) {
          nativeMaintenance?.assertCurrent();
          await fsPromises.rm(canonical, { recursive: true, force: true });
        }
      } finally {
        ownedRoots.delete(canonical);
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        recordFailure(error);
      }
    } finally {
      lease?.release();
    }
  }
}

/** Warm generations retain superseded snapshots until their local cache retires. */
export function retainPluginNativeCapturePath(capturedPath: string): () => void {
  const file = path.resolve(capturedPath);
  if ([...retiringNativeRoots].some((root) => file.startsWith(root + path.sep))) {
    throw new Error("Plugin native capture is being reclaimed");
  }
  nativeReferences.set(file, (nativeReferences.get(file) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const references = nativeReferences.get(file)!;
    if (references === 1) {
      nativeReferences.delete(file);
    } else {
      nativeReferences.set(file, references - 1);
    }
  };
}

/** The caller holds database maintenance and supplies a fresh installed-index reference set. */
export async function prunePluginNativeCaptureDirectories(
  stateDir: string,
  retainedPaths: ReadonlySet<string>,
  assertCurrent: () => void,
  options: { startup?: boolean } = {},
) {
  const removed: string[] = [];
  const warnings: string[] = [];
  assertCurrent();
  await reclaimInstances(
    path.resolve(instanceDirectory(stateDir)),
    (error) => warnings.push(String(error)),
    false,
    { retainedPaths, assertCurrent, removed, ...options },
  );
  return { removed, warnings };
}

/** Coalesce active scans, but throttle diagnostics independently of cleanup retries. */
function sweepPluginSourceCaptureDirectories(stateDir: string): Promise<void> {
  const root = path.resolve(instanceDirectory(stateDir));
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
          `${failures} cleanup failure(s) in ${root}; will retry. First: ${String(firstFailure)}`,
        );
      })
      .finally(() => sweeps.delete(root));
    sweeps.set(root, sweep);
  }
  return sweep;
}

function createCaptureDirectory(
  instance: Instance,
  stateDir: string,
  prefix: string,
  kind = "captures",
): string {
  if (instance.root) {
    const captures = path.join(instance.root, kind);
    try {
      return fs.mkdtempSync(path.join(captures, prefix));
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      // Repair only the payload directory; recreating its parent would lose native custody.
      fs.mkdirSync(captures, { mode: 0o700 });
      return fs.mkdtempSync(path.join(captures, prefix));
    }
  }
  const prepare = (fallback: boolean): string => {
    let directory: string | undefined;
    let lease: SqliteCoordinatorLease | null = null;
    try {
      if (fallback) {
        directory = fs.mkdtempSync(path.join(tmpdir(), "openclaw-plugin-captures-"));
      } else {
        const parent = instanceDirectory(stateDir);
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        instance.managedRoot = fs.realpathSync(parent);
        const candidate = path.join(instance.managedRoot, randomUUID());
        fs.mkdirSync(candidate, { mode: 0o700 });
        directory = candidate;
      }
      const canonical = fs.realpathSync(directory);
      lease = tryAcquireExclusiveSqliteCoordinator(path.join(canonical, LEASE_FILE));
      if (!lease) {
        throw new Error("Could not acquire new plugin source instance");
      }
      const captures = path.join(canonical, kind);
      fs.mkdirSync(captures, { mode: 0o700 });
      const capture = fs.mkdtempSync(path.join(captures, prefix));
      instance.root = canonical;
      instance.lease = lease;
      ownedRoots.add(canonical);
      return capture;
    } catch (error) {
      try {
        lease?.release();
      } catch (releaseError) {
        // Retain custody for release() to retry; never unlink a still-open coordinator.
        instance.root = directory;
        instance.lease = lease ?? undefined;
        instance.closing = true;
        if (directory) {
          ownedRoots.add(directory);
        }
        throw new AggregateError(
          [error, releaseError],
          "Plugin source preparation cleanup failed",
          {
            cause: releaseError,
          },
        );
      }
      if (directory) {
        try {
          removeInstanceSync(directory);
        } catch (cleanupError) {
          warn(cleanupError);
        }
      }
      throw error;
    }
  };
  try {
    return prepare(false);
  } catch (error) {
    if (instance.closing) {
      throw error;
    }
    // The fallback covers the whole allocation, including SQLite and the first capture.
    // Fallback instances have ordinary disposal, but no cross-instance automatic sweep.
    warn(error);
    return prepare(true);
  }
}

function scheduleCaptureCleanup(key: string, instance: Instance): void {
  const scheduler =
    [...instance.references].findLast(
      (reference) => reference.scheduler && !reference.scheduler.signal.aborted,
    )?.scheduler ?? undefined;
  if (instance.scheduler === scheduler) {
    return;
  }
  instance.detachScheduler?.();
  instance.cleanupJob?.cancel();
  instance.scheduler = scheduler;
  instance.cleanupJob = undefined;
  instance.detachScheduler = undefined;
  if (!scheduler) {
    return;
  }
  // Metadata can retain native custody after its Gateway stops accepting timed work.
  const rebind = () => scheduleCaptureCleanup(key, instance);
  scheduler.signal.addEventListener("abort", rebind, { once: true });
  instance.detachScheduler = () => scheduler.signal.removeEventListener("abort", rebind);
  instance.cleanupJob = runInPluginSourceCaptureContext(() =>
    scheduler.schedule({
      id: `plugin-source-captures:${key}`,
      delayMs: CAPTURE_GRACE_MS,
      everyMs: CAPTURE_GRACE_MS,
      run: () => sweepPluginSourceCaptureDirectories(key),
    }),
  );
}

/** Artifact custody survives until every producer and metadata owner releases it. */
export function retainPluginSourceCaptureInstance(stateDir = resolveStateDir()) {
  const key = path.resolve(stateDir);
  const maintenance = pluginSourceCaptureMaintenance.getStore();
  const scheduler = maintenance?.scheduler;
  scheduler?.signal.throwIfAborted();
  let instance = instances.get(key);
  if (instance?.closing) {
    throw new Error(
      "Plugin source instance cleanup is incomplete; retry cleanup before creating captures",
    );
  }
  if (!instance) {
    instance = { references: new Set(), pendingNative: new Set() };
    instances.set(key, instance);
    if (maintenance) {
      void maintenance.run(() => sweepPluginSourceCaptureDirectories(key));
    } else {
      void sweepPluginSourceCaptureDirectories(key);
    }
  }
  const reference: { scheduler: GatewayScheduler | null } = { scheduler: scheduler ?? null };
  instance.references.add(reference);
  scheduleCaptureCleanup(key, instance);
  const retained = instance;
  let released = false;
  const retire = () => {
    if (released) {
      return undefined;
    }
    if (retained.references.size > 1) {
      retained.references.delete(reference);
      scheduleCaptureCleanup(key, retained);
      released = true;
      return undefined;
    }
    const root = retireInstance(key, retained);
    released = true;
    return root;
  };
  return {
    startMaintenance(ownerScheduler: GatewayScheduler) {
      if (released || retained.closing) {
        throw new Error("Plugin source instance has been released");
      }
      ownerScheduler.signal.throwIfAborted();
      reference.scheduler = ownerScheduler;
      scheduleCaptureCleanup(key, retained);
      return sweepPluginSourceCaptureDirectories(key);
    },
    get managedRoot() {
      return retained.managedRoot;
    },
    createDirectory(prefix = PLUGIN_SOURCE_CAPTURE_PREFIX) {
      if (released || retained.closing) {
        throw new Error("Plugin source instance has been released");
      }
      return createCaptureDirectory(retained, key, prefix);
    },
    createNativeDirectory() {
      if (released || retained.closing) {
        throw new Error("Plugin source instance has been released");
      }
      const directory = createCaptureDirectory(retained, key, "admission-", "native");
      retained.pendingNative.add(directory);
      return { directory, commit: () => retained.pendingNative.delete(directory) };
    },
    release() {
      const root = retire();
      if (root) {
        removeInstanceSync(root, retained.pendingNative);
      }
    },
    async releaseAsync() {
      const root = retire();
      if (root) {
        try {
          await fsPromises.rm(path.join(root, "captures"), { recursive: true, force: true });
          for (const directory of retained.pendingNative) {
            await fsPromises.rm(directory, { recursive: true, force: true });
          }
          const native = await fsPromises
            .readdir(path.join(root, "native"))
            .catch((error: unknown) => {
              if (!hasErrnoCode(error, "ENOENT")) {
                throw error;
              }
              return [];
            });
          if (native.length === 0) {
            await fsPromises.rm(root, { recursive: true, force: true });
          }
        } catch (error) {
          warn(error);
        }
      }
    },
  };
}

/** Native snapshots become durable only after their installed-index receipt is published. */
export function createPluginNativeCaptureRoot(stateDir = resolveStateDir()) {
  const instance = retainPluginSourceCaptureInstance(stateDir);
  try {
    const root = instance.createNativeDirectory();
    let committed = false;
    let disposed = false;
    return {
      directory: root.directory,
      commit() {
        if (disposed) {
          throw new Error("Plugin native capture has been disposed");
        }
        root.commit();
        committed = true;
      },
      dispose() {
        if (!disposed) {
          if (!committed && !retainLoadedPluginSourceCapture(root.directory)) {
            fs.rmSync(root.directory, { recursive: true, force: true });
          }
          disposed = true;
          instance.release();
        }
      },
      async disposeAsync() {
        if (!disposed) {
          if (!committed && !retainLoadedPluginSourceCapture(root.directory)) {
            await removeTemporaryArtifacts(root.directory, "Plugin native capture");
          }
          disposed = true;
          await instance.releaseAsync();
        }
      },
    };
  } catch (error) {
    instance.release();
    throw error;
  }
}

/** The producer retains this root until its worker has confirmed exit. */
export function createPluginSourceCaptureRoot(stateDir: string, prefix: string) {
  const instance = retainPluginSourceCaptureInstance(stateDir);
  try {
    const directory = instance.createDirectory(prefix);
    return {
      directory,
      managedRoot: instance.managedRoot,
      release: async () => {
        if (!retainLoadedPluginSourceCapture(directory)) {
          await removeTemporaryArtifacts(directory, "Plugin source worker");
        }
        await instance.releaseAsync();
      },
    };
  } catch (error) {
    instance.release();
    throw error;
  }
}
