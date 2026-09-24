import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import {
  tryAcquireExclusiveSqliteCoordinator,
  type SqliteCoordinatorLease,
} from "../infra/sqlite-coordinator.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runInPluginSourceCaptureContext } from "./plugin-source-capture-context.js";
import { PLUGIN_SOURCE_CAPTURE_PREFIX } from "./plugin-source-capture-path.js";

const CAPTURE_GRACE_MS = 60 * 60 * 1_000;
const LEASE_FILE = "owner.sqlite";
type Instance = {
  references: number;
  closing?: boolean;
  timer: ReturnType<typeof setInterval>;
  root?: string;
  managedRoot?: string;
  lease?: SqliteCoordinatorLease;
};
const { instances, ownedRoots, sweeps, warningBackoff } = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourceCaptureInstances"),
  () => {
    process.once("exit", () => {
      // Explicit exits cannot await generation disposal. These native leases belong
      // only to this exiting process; worker overrides remain with their parent.
      for (const [key, instance] of instances) {
        try {
          const root = retireInstance(key, instance);
          if (root) {
            fs.rmSync(root, { recursive: true, force: true });
          }
        } catch (error) {
          process.stderr.write(`Plugin source capture exit cleanup failed: ${String(error)}\n`);
        }
      }
    });
    return {
      instances: new Map<string, Instance>(),
      ownedRoots: new Set<string>(),
      sweeps: new Map<string, Promise<void>>(),
      warningBackoff: new Map<string, { next: number; delay: number }>(),
    };
  },
);

function retireInstance(key: string, instance: Instance): string | undefined {
  instance.closing = true;
  // Keep custody and the retryable handle if native close fails.
  instance.lease?.release();
  if (instance.root) {
    ownedRoots.delete(instance.root);
  }
  instance.references = 0;
  instances.delete(key);
  clearInterval(instance.timer);
  return instance.root;
}

function instanceDirectory(stateDir: string): string {
  return path.join(stateDir, "tmp", "plugin-captures");
}

function warn(error: unknown) {
  process.emitWarning(`Plugin source capture cleanup: ${String(error)}`);
}

async function reclaimInstances(
  root: string,
  recordFailure: (error: unknown) => void,
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
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(root, entry.name);
    let lease: SqliteCoordinatorLease | null = null;
    try {
      const stat = await fsPromises.lstat(directory);
      if (!stat.isDirectory() || stat.mtimeMs > cutoff) {
        continue;
      }
      const canonical = await fsPromises.realpath(directory);
      // Opening/closing a second native connection can disturb this process's POSIX locks.
      if (ownedRoots.has(canonical)) {
        continue;
      }
      const leasePath = path.join(canonical, LEASE_FILE);
      const leaseStat = await fsPromises.lstat(leasePath);
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
        lease.release();
        lease = null;
        // Instance IDs are never reused. Close the lease before removing its file on Windows.
        await fsPromises.rm(canonical, { recursive: true, force: true });
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

/** Coalesce active scans, but throttle diagnostics independently of cleanup retries. */
export function sweepPluginSourceCaptureDirectories(stateDir = resolveStateDir()): Promise<void> {
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

function createCaptureDirectory(instance: Instance, stateDir: string, prefix: string): string {
  if (instance.root) {
    return fs.mkdtempSync(path.join(instance.root, "captures", prefix));
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
      const captures = path.join(canonical, "captures");
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
          fs.rmSync(directory, { recursive: true, force: true });
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

/** Metadata and its captures share custody; standalone CLI captures own their own lifetime. */
export function retainPluginSourceCaptureInstance(stateDir = resolveStateDir()) {
  const key = path.resolve(stateDir);
  let instance = instances.get(key);
  if (instance?.closing) {
    throw new Error(
      "Plugin source instance cleanup is incomplete; retry cleanup before creating captures",
    );
  }
  if (!instance) {
    const timer = runInPluginSourceCaptureContext(() =>
      setInterval(() => void sweepPluginSourceCaptureDirectories(key), CAPTURE_GRACE_MS),
    );
    timer.unref();
    instance = { references: 0, timer };
    instances.set(key, instance);
    void sweepPluginSourceCaptureDirectories(key);
  }
  instance.references += 1;
  const retained = instance;
  let released = false;
  const retire = () => {
    if (released) {
      return undefined;
    }
    if (retained.references > 1) {
      retained.references -= 1;
      released = true;
      return undefined;
    }
    const root = retireInstance(key, retained);
    released = true;
    return root;
  };
  return {
    get managedRoot() {
      return retained.managedRoot;
    },
    createDirectory(prefix = PLUGIN_SOURCE_CAPTURE_PREFIX) {
      if (released || retained.closing) {
        throw new Error("Plugin source instance has been released");
      }
      return createCaptureDirectory(retained, key, prefix);
    },
    release() {
      const root = retire();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    async releaseAsync() {
      const root = retire();
      if (root) {
        await removeTemporaryArtifacts(root, "Plugin source instance");
      }
    },
  };
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
        await removeTemporaryArtifacts(directory, "Plugin source worker");
        await instance.releaseAsync();
      },
    };
  } catch (error) {
    instance.release();
    throw error;
  }
}
