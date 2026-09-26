import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import type { GatewayScheduler, GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import { isPathInside } from "../infra/path-guards.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import {
  acquireSqliteStagingToken,
  SQLITE_STAGING_TOKEN_FILES,
  type SqliteStagingToken,
} from "../infra/sqlite-staging-token.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  pluginSourceCaptureMaintenance,
  runInPluginSourceCaptureContext,
} from "./plugin-source-capture-context.js";
import { observePluginNativeLoads } from "./plugin-source-capture-native-loads.js";
import {
  isLegacyPluginSourceCaptureName,
  PLUGIN_SOURCE_CAPTURE_PREFIX,
  resolvePluginSourceCaptureFallbackPrefix,
  resolvePluginSourceCapturesDirectory,
} from "./plugin-source-capture-path.js";

const CAPTURE_GRACE_MS = 60 * 60 * 1_000;

type Instance = {
  references: Set<{ scheduler: GatewayScheduler | null }>;
  pendingNative: Set<string>;
  closing?: boolean;
  scheduler?: GatewayScheduler;
  cleanupJob?: GatewayScheduledJob;
  detachScheduler?: () => void;
  root?: string;
  managedRoot?: string;
  token?: SqliteStagingToken;
};
type NativeCaptureMaintenance = {
  retainedPaths: ReadonlySet<string>;
  assertCurrent: () => void;
  removed: string[];
  startup?: boolean;
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
  const observedNativePaths = observePluginNativeLoads();
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
  let removalRoot = instance.root;
  // Keep the exact native token available if retirement or close needs a retry.
  try {
    instance.token?.(true);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    // Enclosing state can disappear before deferred disposal. Missing ownership
    // permits closing our handle, never deleting residual or replacement files.
    instance.token?.();
    removalRoot = undefined;
  }
  if (instance.root) {
    ownedRoots.delete(instance.root);
  }
  instance.references.clear();
  instances.delete(key);
  instance.cleanupJob?.cancel();
  instance.detachScheduler?.();
  return removalRoot;
}

function warn(error: unknown) {
  process.emitWarning(`Plugin source capture cleanup: ${String(error)}`);
}

/** Reclamation owns an existing native token until its captured payload is gone. */
async function reclaimInstance(
  directory: string,
  originalDirectory: fs.Stats,
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
  const release = acquireSqliteStagingToken(directory, "reclaim");
  let released = false;
  ownedRoots.add(directory);
  try {
    if (!unchanged()) {
      return;
    }
    const native = path.join(directory, "native");
    // A producer can publish native bytes between inspection and exclusive admission.
    const nativeStat = fs.lstatSync(native, { throwIfNoEntry: false });
    await fsPromises.rm(captures, { recursive: true, force: true });
    let retainedNative = Boolean(nativeStat);
    if (nativeStat?.isDirectory() && nativeMaintenance) {
      for (const nativeEntry of await fsPromises.readdir(native, { withFileTypes: true })) {
        const nativeDirectory = path.join(native, nativeEntry.name);
        if (!nativeEntry.isDirectory()) {
          continue;
        }
        nativeMaintenance.assertCurrent();
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
          await fsPromises.rm(nativeDirectory, { recursive: true, force: true });
          nativeMaintenance.removed.push(nativeDirectory);
        } finally {
          retiringNativeRoots.delete(nativeDirectory);
        }
      }
      retainedNative = (await fsPromises.readdir(native)).length > 0;
    }
    // Retirement closes staging admission; committed native readers use receipt-bound files.
    release(true);
    released = true;
    // The shipped instance ID is never reused. Windows requires closing before unlink.
    if (!retainedNative && unchanged()) {
      nativeMaintenance?.assertCurrent();
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  } finally {
    try {
      if (!released) {
        release();
      }
    } finally {
      ownedRoots.delete(directory);
    }
  }
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
  // A sharing violation must leave the custody token beside any retained payload.
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
  nativeMaintenance?: NativeCaptureMaintenance,
  fallbackPrefix?: string,
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
  if (entries.length === 0) {
    return;
  }
  const cutoff = Date.now() - CAPTURE_GRACE_MS;
  let legacyAllowed: boolean | undefined;
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
      const nativeStat = await fsPromises
        .lstat(path.join(canonical, "native"))
        .catch((error: unknown) => {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
          return undefined;
        });
      const tokenStat = await fsPromises.lstat(tokenPath).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        return undefined;
      });
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
      await reclaimInstance(canonical, stat, nativeMaintenance);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !isSqliteLockError(error)) {
        recordFailure(error);
      }
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
  const recordFailure = (error: unknown) => warnings.push(String(error));
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
    let token: SqliteStagingToken | undefined;
    try {
      if (fallback) {
        directory = fs.mkdtempSync(
          path.join(tmpdir(), resolvePluginSourceCaptureFallbackPrefix(stateDir)),
        );
      } else {
        const parent = resolvePluginSourceCapturesDirectory(stateDir);
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        instance.managedRoot = fs.realpathSync(parent);
        const candidate = path.join(instance.managedRoot, randomUUID());
        fs.mkdirSync(candidate, { mode: 0o700 });
        directory = candidate;
      }
      const canonical = fs.realpathSync(directory);
      token = acquireSqliteStagingToken(canonical, "create");
      const captures = path.join(canonical, kind);
      fs.mkdirSync(captures, { mode: 0o700 });
      const capture = fs.mkdtempSync(path.join(captures, prefix));
      instance.root = canonical;
      instance.token = token;
      ownedRoots.add(canonical);
      return capture;
    } catch (error) {
      try {
        token?.(true);
      } catch (releaseError) {
        instance.root = directory;
        instance.token = token;
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
    // The fallback covers the whole allocation, including the token and first capture.
    // Fallback instances retain the same custody within their state's qualified namespace.
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
