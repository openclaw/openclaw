import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduler, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import {
  acquireSqliteStagingToken,
  SQLITE_STAGING_TOKEN_FILES,
  type SqliteStagingToken,
} from "../infra/sqlite-staging-token.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";
import {
  pluginSourceCaptureMaintenance,
  resolvePluginSourceCaptureStorage,
  runInPluginSourceCaptureContext,
} from "./plugin-source-capture-context.js";
import {
  createPluginNativeCaptureCustody,
  type NativeCaptureMaintenance,
} from "./plugin-source-capture-native-loads.js";
import {
  isLegacyPluginSourceCaptureName,
  PLUGIN_SOURCE_CAPTURE_PREFIX,
  resolvePluginSourceCaptureFallbackPrefix,
  resolvePluginSourceCapturesDirectory,
} from "./plugin-source-capture-path.js";

const CAPTURE_GRACE_MS = 60 * 60 * 1_000;

type Instance = {
  storage: PluginSourceCaptureStorage;
  references: Set<{ scheduler: GatewayScheduler | null }>;
  pendingNative: Set<string>;
  closing?: boolean;
  scheduler?: GatewayScheduler;
  cleanupScope?: GatewaySchedulerScope;
  root?: string;
  managedRoot?: string;
  token?: SqliteStagingToken;
};
const {
  instances,
  ownedRoots,
  reclaimInstance,
  isPluginSourceCaptureRetained,
  retainLoadedPluginSourceCapture,
  retainPluginNativeCapturePath,
  sweeps,
} = resolveGlobalSingleton(Symbol.for("openclaw.pluginSourceCaptureInstances"), () => {
  const instanceRoots = new Set<string>();
  const nativeCustody = createPluginNativeCaptureCustody(instanceRoots);
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
    ownedRoots: instanceRoots,
    ...nativeCustody,
    sweeps: new Map<string, Promise<void>>(),
  };
});

export {
  isPluginSourceCaptureRetained,
  retainLoadedPluginSourceCapture,
  retainPluginNativeCapturePath,
};

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
  scheduleCaptureCleanup(key, instance);
  return removalRoot;
}

function warn(error: unknown) {
  process.emitWarning(`Plugin source capture cleanup: ${String(error)}`);
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
        await nativeMaintenance?.assertCurrent();
        const current = fs.lstatSync(canonical);
        if (
          current.isDirectory() &&
          current.dev === stat.dev &&
          current.ino === stat.ino &&
          current.uid === stat.uid &&
          (!process.getuid || current.uid === process.getuid())
        ) {
          // Legacy producers surviving the grace period are best effort; managed captures retain tokens.
          await fsPromises.rm(canonical, { recursive: true, force: true });
        }
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

/** Only exact process-owned roots are excluded; a partially retained root may still need cleanup. */
export async function hasPluginNativeCaptureCleanupCandidates(stateDir: string): Promise<boolean> {
  for (const [root, prefix] of [
    [resolvePluginSourceCapturesDirectory(stateDir), undefined],
    [tmpdir(), resolvePluginSourceCaptureFallbackPrefix(stateDir)],
  ] as const) {
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || (prefix && !entry.name.startsWith(prefix))) {
        continue;
      }
      try {
        if (!ownedRoots.has(await fsPromises.realpath(path.join(root, entry.name)))) {
          return true;
        }
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
  }
  return false;
}

/** The caller holds plugin lifecycle or offline maintenance custody and fresh index references. */
export async function prunePluginNativeCaptureDirectories(
  stateDir: string,
  retainedPaths: ReadonlySet<string>,
  assertCurrent: () => void | Promise<void>,
  options: { startup?: boolean } = {},
) {
  const removed: string[] = [];
  const warnings: string[] = [];
  await assertCurrent();
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

/** Coalesce active scans and report one summary per sweep. */
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
          return;
        }
        warn(
          `${failures} cleanup failure(s) in ${root}; will retry. First: ${formatErrorMessage(firstFailure)}`,
        );
      })
      .finally(() => sweeps.delete(root));
    sweeps.set(root, sweep);
  }
  return sweep;
}

function createCaptureDirectory(instance: Instance, prefix: string, kind = "captures"): string {
  const { stateDir, placement } = instance.storage;
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
        throw createSqliteLifecycleAggregateError(
          [error, releaseError],
          "Plugin source preparation cleanup failed",
          error,
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
  if (placement === "temporary") {
    return prepare(true);
  }
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
  instance.scheduler = scheduler;
  instance.cleanupScope?.beginClose();
  instance.cleanupScope = undefined;
  if (!scheduler || instance.storage.placement === "temporary") {
    return;
  }
  // Metadata can retain native custody after its Gateway stops accepting timed work.
  const scope = scheduler.scope();
  instance.cleanupScope = scope;
  scope.signal.addEventListener("abort", () => scheduleCaptureCleanup(key, instance), {
    once: true,
  });
  runInPluginSourceCaptureContext(() =>
    scope.schedule({
      id: `plugin-source-captures:${key}`,
      delayMs: CAPTURE_GRACE_MS,
      everyMs: CAPTURE_GRACE_MS,
      run: () => sweepPluginSourceCaptureDirectories(instance.storage.stateDir),
    }),
  );
}

/** Artifact custody survives until every producer and metadata owner releases it. */
export function retainPluginSourceCaptureInstance(
  stateDir?: string,
  placement?: PluginSourceCaptureStorage["placement"],
) {
  const storage = resolvePluginSourceCaptureStorage(stateDir, placement);
  const key = JSON.stringify([storage.stateDir, storage.placement]);
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
    instance = { storage, references: new Set(), pendingNative: new Set() };
    instances.set(key, instance);
    if (storage.placement === "state") {
      if (maintenance) {
        void maintenance.run(() => sweepPluginSourceCaptureDirectories(storage.stateDir));
      } else {
        void sweepPluginSourceCaptureDirectories(storage.stateDir);
      }
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
      return storage.placement === "temporary"
        ? Promise.resolve()
        : sweepPluginSourceCaptureDirectories(storage.stateDir);
    },
    get managedRoot() {
      return retained.managedRoot;
    },
    createDirectory(prefix = PLUGIN_SOURCE_CAPTURE_PREFIX) {
      if (released || retained.closing) {
        throw new Error("Plugin source instance has been released");
      }
      return createCaptureDirectory(retained, prefix);
    },
    createNativeDirectory() {
      if (released || retained.closing) {
        throw new Error("Plugin source instance has been released");
      }
      const directory = createCaptureDirectory(retained, "admission-", "native");
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
      const scope = retained.cleanupScope;
      const root = retire();
      if (scope !== retained.cleanupScope) {
        await scope?.stop();
      }
      if (retained.references.size === 0) {
        // A previous scheduler may still own the root's coalesced scan after rebinding.
        await sweeps.get(path.resolve(resolvePluginSourceCapturesDirectory(storage.stateDir)));
      }
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
export function createPluginNativeCaptureRoot(
  stateDir?: string,
  placement?: PluginSourceCaptureStorage["placement"],
) {
  const instance = retainPluginSourceCaptureInstance(stateDir, placement);
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
