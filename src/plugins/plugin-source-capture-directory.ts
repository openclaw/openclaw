import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import type { GatewayScheduler, GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import type {
  WorkerOwnedSqliteStagingToken,
  WorkerOwnedSqliteStagingTokenAdmission,
} from "../infra/sqlite-snapshot-staging.types.js";
import {
  acquireSqliteStagingToken,
  SQLITE_STAGING_TOKEN_FILES,
  type SqliteStagingToken,
} from "../infra/sqlite-staging-token.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  PluginSourceCaptureInstance,
  PluginSourceCaptureStorage,
} from "./plugin-instance-invocation.types.js";
import {
  pluginSourceCaptureMaintenance,
  resolvePluginSourceCaptureStorage,
  runInPluginSourceCaptureContext,
} from "./plugin-source-capture-context.js";
import {
  CAPTURE_GRACE_MS,
  createPluginSourceCaptureMaintenance,
  type PendingPluginSourceCaptureReclamation,
} from "./plugin-source-capture-maintenance.js";
import { createPluginNativeCaptureCustody } from "./plugin-source-capture-native-loads.js";
import {
  PLUGIN_SOURCE_CAPTURE_PREFIX,
  resolvePluginSourceCaptureFallbackPrefix,
  resolvePluginSourceCapturesDirectory,
} from "./plugin-source-capture-path.js";
import {
  createPluginNativeCapturePayload,
  removePluginSourceCapturePayload,
  startPluginSourceCapturePayload,
} from "./plugin-source-capture-payload.js";

type Instance = {
  storage: PluginSourceCaptureStorage;
  references: Set<{ scheduler: GatewayScheduler | null }>;
  pendingNative: Set<string>;
  closing?: boolean;
  scheduler?: GatewayScheduler;
  cleanupJob?: GatewayScheduledJob;
  detachScheduler?: () => void;
  root?: string;
  managedRoot?: string;
  token?: SqliteStagingToken;
  workerBacked?: true;
  workerAdmission?: WorkerOwnedSqliteStagingTokenAdmission;
  workerToken?: WorkerOwnedSqliteStagingToken;
  preparation?: Promise<void>;
  failedPreparationCleanup?: Promise<void>;
  unadmittedCleanup?: () => Promise<void>;
  finalRemovalStarted?: true;
  reservedCapture?: { directory: string; prefix: string };
};
const {
  instances,
  ownedRoots,
  nativeReferences,
  retiringNativeRoots,
  isPluginSourceCaptureRetained,
  retainLoadedPluginSourceCapture,
  retainPluginNativeCapturePath,
  sweeps,
  warningBackoff,
  pendingReclamations,
} = resolveGlobalSingleton(Symbol.for("openclaw.pluginSourceCaptureInstances"), () => {
  const instanceRoots = new Set<string>();
  const nativeCustody = createPluginNativeCaptureCustody(instanceRoots);
  process.once("exit", () => {
    // Explicit exits cannot await generation disposal. These native leases belong
    // only to this exiting process; worker overrides remain with their parent.
    for (const [key, instance] of instances) {
      if (instance.workerBacked) {
        // A hard exit cannot acknowledge asynchronous token retirement or adopt its root.
        continue;
      }
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
    warningBackoff: new Map<string, { next: number; delay: number }>(),
    pendingReclamations: new Map<string, PendingPluginSourceCaptureReclamation>(),
  };
});

const { prunePluginNativeCaptureDirectories, sweepPluginSourceCaptureDirectories } =
  createPluginSourceCaptureMaintenance({
    ownedRoots,
    nativeReferences,
    retiringNativeRoots,
    retainLoadedPluginSourceCapture,
    sweeps,
    warningBackoff,
    pendingReclamations,
    warn,
  });

export {
  prunePluginNativeCaptureDirectories,
  isPluginSourceCaptureRetained,
  retainLoadedPluginSourceCapture,
  retainPluginNativeCapturePath,
};

function retireInstance(key: string, instance: Instance): string | undefined {
  if (instance.workerBacked) {
    throw new Error("Prepared plugin source capture requires asynchronous retirement");
  }
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

async function retireWorkerCapture(instance: Instance): Promise<"retired" | "missing" | undefined> {
  const admission = instance.workerAdmission;
  if (!admission) {
    return undefined;
  }
  try {
    await admission.startClose().result;
    return "retired";
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    await admission.startRelease().result;
    return "missing";
  }
}

function assertWorkerCaptureCurrent(instance: Instance): void {
  if (
    instance.workerBacked &&
    (!instance.workerToken?.isCurrent() || !workerCaptureIdentityMatches(instance))
  ) {
    throw new Error("Prepared plugin source capture has lost its original writer");
  }
}

function workerCaptureIdentityMatches(instance: Instance): boolean {
  return readWorkerCaptureIdentity(instance) === "original";
}

function readWorkerCaptureIdentity(
  instance: Instance,
): "original" | "partial" | "absent" | undefined {
  const identity = instance.workerAdmission?.identity;
  if (!instance.root || !identity) {
    return undefined;
  }
  const directory = fs.lstatSync(instance.root, { bigint: true, throwIfNoEntry: false });
  if (!directory) {
    return "absent";
  }
  if (
    !directory.isDirectory() ||
    String(directory.dev) !== identity.directory.dev ||
    String(directory.ino) !== identity.directory.ino
  ) {
    return undefined;
  }
  const token = fs.lstatSync(path.join(instance.root, SQLITE_STAGING_TOKEN_FILES[0]), {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!token) {
    return instance.finalRemovalStarted ? "partial" : undefined;
  }
  return token.isFile() &&
    token.nlink === 1n &&
    String(token.dev) === identity.token.dev &&
    String(token.ino) === identity.token.ino
    ? "original"
    : undefined;
}

function createCaptureDirectory(instance: Instance, prefix: string, kind = "captures"): string {
  assertWorkerCaptureCurrent(instance);
  const { stateDir, placement } = instance.storage;
  if (kind === "captures" && instance.reservedCapture?.prefix === prefix) {
    const { directory } = instance.reservedCapture;
    instance.reservedCapture = undefined;
    return directory;
  }
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
  instance.detachScheduler?.();
  instance.cleanupJob?.cancel();
  instance.scheduler = scheduler;
  instance.cleanupJob = undefined;
  instance.detachScheduler = undefined;
  if (!scheduler || instance.storage.placement === "temporary") {
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
      run: () => sweepPluginSourceCaptureDirectories(instance.storage.stateDir),
    }),
  );
}

/** Artifact custody survives until every producer and metadata owner releases it. */
export function retainPluginSourceCaptureInstance(
  stateDir?: string,
  placement?: PluginSourceCaptureStorage["placement"],
): PluginSourceCaptureInstance {
  const storage = resolvePluginSourceCaptureStorage(stateDir, placement);
  return retainCaptureInstance(storage).reference;
}

function retainCaptureInstance(storage: PluginSourceCaptureStorage, workerBacked?: true) {
  const key = JSON.stringify(
    workerBacked
      ? [storage.stateDir, storage.placement, "worker"]
      : [storage.stateDir, storage.placement],
  );
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
    instance = { storage, references: new Set(), pendingNative: new Set(), workerBacked };
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
  let releasing: Promise<void> | undefined;
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
  const assertCurrent = () => {
    if (released || retained.closing) {
      throw new Error("Plugin source instance has been released");
    }
    assertWorkerCaptureCurrent(retained);
  };
  const handle: PluginSourceCaptureInstance = {
    isCurrent() {
      if (released || retained.closing) {
        return false;
      }
      try {
        assertWorkerCaptureCurrent(retained);
        return true;
      } catch {
        return false;
      }
    },
    assertCurrent,
    startMaintenance(ownerScheduler: GatewayScheduler) {
      assertCurrent();
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
      assertCurrent();
      const directory = createCaptureDirectory(retained, prefix);
      assertCurrent();
      return directory;
    },
    createNativeDirectory() {
      assertCurrent();
      const directory = createCaptureDirectory(retained, "admission-", "native");
      retained.pendingNative.add(directory);
      assertCurrent();
      return {
        directory,
        commit: () => {
          assertCurrent();
          return retained.pendingNative.delete(directory);
        },
      };
    },
    release() {
      const root = retire();
      if (root) {
        removeInstanceSync(root, retained.pendingNative);
      }
    },
    releaseAsync() {
      return (releasing ??= releaseAsync().finally(() => {
        releasing = undefined;
      }));
    },
  };
  async function releaseAsync(): Promise<void> {
    if (released) {
      return;
    }
    if (!retained.workerBacked) {
      const root = retire();
      if (root) {
        await removePluginSourceCapturePayload(root, retained.pendingNative).catch(warn);
      }
      return;
    }
    if (retained.references.size > 1) {
      retained.references.delete(reference);
      scheduleCaptureCleanup(key, retained);
      released = true;
      return;
    }
    if (retained.root && retainLoadedPluginSourceCapture(retained.root)) {
      assertWorkerCaptureCurrent(retained);
      retained.references.clear();
      scheduleCaptureCleanup(key, retained);
      released = true;
      return;
    }
    retained.closing = true;
    if (retained.root && !retained.workerAdmission) {
      if (!retained.unadmittedCleanup) {
        throw new Error("Plugin source preparation has no token identity for removal");
      }
      await retained.unadmittedCleanup();
      retained.unadmittedCleanup = undefined;
    }
    const retirement = await retireWorkerCapture(retained);
    if (retained.root && retirement === "retired") {
      const identity = readWorkerCaptureIdentity(retained);
      if (!identity) {
        throw new Error("Plugin source capture identity changed before removal");
      }
      // Confirmed retirement and absence settle custody without deleting any path.
      if (identity !== "absent") {
        await removePluginSourceCapturePayload(
          retained.root,
          retained.pendingNative,
          () => {
            const current = readWorkerCaptureIdentity(retained);
            if (!current || current === "absent") {
              throw new Error("Plugin source capture identity changed during removal");
            }
          },
          () => {
            retained.finalRemovalStarted = true;
          },
        );
      }
    }
    if (retained.root) {
      ownedRoots.delete(retained.root);
    }
    retained.references.clear();
    instances.delete(key);
    retained.cleanupJob?.cancel();
    retained.detachScheduler?.();
    released = true;
  }
  return { instance: retained, reference: handle };
}

async function prepareCaptureInstance(instance: Instance, prefix: string): Promise<void> {
  const { stateDir, placement } = instance.storage;
  const { startWorkerOwnedSqliteStagingToken } = await runInPluginSourceCaptureContext(
    () => import("../infra/sqlite-snapshot-staging-owner.js"),
  );
  const prepare = async (fallback: boolean) => {
    let directory: string | undefined;
    let original: fs.BigIntStats | undefined;
    try {
      if (fallback) {
        directory = await fsPromises.mkdtemp(
          path.join(tmpdir(), resolvePluginSourceCaptureFallbackPrefix(stateDir)),
        );
      } else {
        const parent = resolvePluginSourceCapturesDirectory(stateDir);
        await fsPromises.mkdir(parent, { recursive: true, mode: 0o700 });
        instance.managedRoot = await fsPromises.realpath(parent);
        directory = path.join(instance.managedRoot, randomUUID());
        await fsPromises.mkdir(directory, { mode: 0o700 });
      }
      instance.root = directory;
      ownedRoots.add(directory);
      original = await fsPromises.lstat(directory, { bigint: true });
      instance.root = await fsPromises.realpath(directory);
      ownedRoots.delete(directory);
      ownedRoots.add(instance.root);
      instance.workerAdmission = startWorkerOwnedSqliteStagingToken(instance.root, "create", {
        expectedDirectoryIdentity: {
          dev: String(original.dev),
          ino: String(original.ino),
        },
      });
      instance.workerToken = await instance.workerAdmission.result;
      assertWorkerCaptureCurrent(instance);
      const captures = path.join(instance.root, "captures");
      await fsPromises.mkdir(captures, { mode: 0o700 });
      assertWorkerCaptureCurrent(instance);
      const capture = await fsPromises.mkdtemp(path.join(captures, prefix));
      assertWorkerCaptureCurrent(instance);
      instance.reservedCapture = { directory: capture, prefix };
    } catch (error) {
      const assertUnadmittedTokenAbsent = () => {
        const originalPath = directory;
        if (
          !instance.workerAdmission &&
          originalPath &&
          SQLITE_STAGING_TOKEN_FILES.some((file) =>
            fs.lstatSync(path.join(originalPath, file), { throwIfNoEntry: false }),
          )
        ) {
          throw new Error("Plugin source preparation has unowned token files", { cause: error });
        }
      };
      const cleanupOriginal = async () => {
        const retirement = await retireWorkerCapture(instance);
        if (directory && retirement !== "missing") {
          const current = await fsPromises
            .lstat(directory, { bigint: true })
            .catch((statError: unknown) => {
              if (!hasErrnoCode(statError, "ENOENT")) {
                throw statError;
              }
              return undefined;
            });
          if (
            current &&
            (!original ||
              !current.isDirectory() ||
              current.dev !== original.dev ||
              current.ino !== original.ino ||
              (instance.workerAdmission && !workerCaptureIdentityMatches(instance)))
          ) {
            throw new Error("Plugin source preparation lost its original directory identity", {
              cause: error,
            });
          }
          if (current) {
            assertUnadmittedTokenAbsent();
            const originalPath = directory;
            await removePluginSourceCapturePayload(
              originalPath,
              instance.pendingNative,
              () => {
                const currentPath = fs.lstatSync(originalPath, { bigint: true });
                if (
                  !original ||
                  !currentPath.isDirectory() ||
                  currentPath.dev !== original.dev ||
                  currentPath.ino !== original.ino ||
                  (instance.workerAdmission && !workerCaptureIdentityMatches(instance))
                ) {
                  throw new Error("Plugin source preparation identity changed during removal", {
                    cause: error,
                  });
                }
                assertUnadmittedTokenAbsent();
              },
              retirement === "retired"
                ? () => {
                    instance.finalRemovalStarted = true;
                  }
                : undefined,
            );
          }
        }
      };
      if (original?.isDirectory() && !instance.workerAdmission) {
        instance.unadmittedCleanup = cleanupOriginal;
      }
      const cleanup = cleanupOriginal();
      try {
        await cleanup;
      } catch (cleanupError) {
        instance.failedPreparationCleanup = cleanup;
        instance.closing = true;
        throw createSqliteLifecycleAggregateError(
          [error, cleanupError],
          "Plugin source preparation cleanup failed",
          error,
        );
      }
      if (instance.root) {
        ownedRoots.delete(instance.root);
      }
      instance.root = undefined;
      instance.unadmittedCleanup = undefined;
      instance.finalRemovalStarted = undefined;
      instance.workerAdmission = undefined;
      instance.workerToken = undefined;
      throw error;
    }
  };
  if (placement === "temporary") {
    await prepare(true);
    return;
  }
  try {
    await prepare(false);
  } catch (error) {
    if (instance.closing) {
      throw error;
    }
    warn(error);
    await prepare(true);
  }
}

/** The caller retains cleanup before awaiting the original worker-backed preparation. */
export function startPluginSourceCaptureRoot(stateDir: string, prefix: string) {
  return startPluginSourceCapturePayload(
    () => {
      const storage = resolvePluginSourceCaptureStorage(stateDir);
      const { instance, reference } = retainCaptureInstance(storage, true);
      instance.preparation ??= prepareCaptureInstance(instance, prefix);
      return {
        reference,
        preparation: instance.preparation,
        failedCleanup: () => instance.failedPreparationCleanup,
      };
    },
    prefix,
    retainLoadedPluginSourceCapture,
  );
}

/** Native snapshots become durable only after their installed-index receipt is published. */
export function createPluginNativeCaptureRoot(
  stateDir?: string,
  placement?: PluginSourceCaptureStorage["placement"],
) {
  return createPluginNativeCapturePayload(
    retainPluginSourceCaptureInstance(stateDir, placement),
    retainLoadedPluginSourceCapture,
  );
}
