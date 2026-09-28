// Shared lock owner for root/include mutation and direct config IO writes.
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertDirectoryIdentitySync, readDirectoryIdentity } from "@openclaw/fs-safe/advanced";
import { isMissingPathError } from "../infra/errno.js";
import { formatErrorMessage, isErrno } from "../infra/errors.js";
import {
  acquireFileLock,
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  withFileLock,
  type FileLockHandle,
} from "../infra/file-lock.js";
import {
  getUpdateDoctorConfigWriteAuthority,
  recordUpdateDoctorConfigWriteRefusal,
} from "../infra/update-doctor-result.js";
import { createManagedHandoffLeaseStore } from "../infra/update-managed-service-handoff-lease.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../shared/deferred.js";
import { assertConfigWriteAllowedInCurrentMode } from "./config-write-guard.js";
import { composeConfigWriteAssertions } from "./write-authority.js";

const CONFIG_MUTATION_LOCK_OPTIONS = {
  retries: { retries: 80, factor: 1.2, minTimeout: 25, maxTimeout: 250, randomize: true },
  stale: 30_000,
} as const;

type LockScope = {
  active: boolean;
  accepting: boolean;
  pending: Set<Promise<unknown>>;
  readonly sourceOnly: boolean;
  readonly assertCurrent?: () => void;
};
const activeConfigMutationLocks = new AsyncLocalStorage<{
  paths: Map<string, LockScope>;
  current: LockScope;
}>();
const configMutationQueue = new KeyedAsyncQueue();
const queuedConfigMutations = new Map<string, number>();

function enqueueConfigMutation<T>(pathname: string, run: () => Promise<T>): Promise<T> {
  return configMutationQueue.enqueue(pathname, run, {
    onEnqueue: () => {
      queuedConfigMutations.set(pathname, (queuedConfigMutations.get(pathname) ?? 0) + 1);
    },
    onSettle: () => {
      const remaining = queuedConfigMutations.get(pathname)! - 1;
      if (remaining === 0) {
        queuedConfigMutations.delete(pathname);
      } else {
        queuedConfigMutations.set(pathname, remaining);
      }
    },
  });
}

/** Capture the live source owner, not merely the fact that a lock was once held. */
export function captureConfigWriteLockGuard(pathname: string): (() => void) | undefined {
  const context = activeConfigMutationLocks.getStore();
  const guarded = [...new Set(context?.paths.values())].filter((scope) => scope.assertCurrent);
  if (!guarded.length) {
    return undefined;
  }
  const target = context?.paths.get(path.resolve(pathname));
  return composeConfigWriteAssertions(
    () => {
      if (!target?.active || !target.assertCurrent) {
        throw new Error("Config write has no live source ownership for this path.");
      }
    },
    ...guarded.flatMap((scope) => [
      () => {
        if (!scope.active) {
          throw new Error("Config write source ownership has closed.");
        }
      },
      scope.assertCurrent,
    ]),
  );
}

async function runConfigLockScope<T>(
  configPaths: readonly string[],
  fn: (assertCurrent: () => void) => Promise<T>,
  assertCurrent?: () => void,
  sourceOnly = false,
): Promise<T> {
  const scope: LockScope = {
    active: true,
    accepting: true,
    pending: new Set(),
    sourceOnly,
    assertCurrent,
  };
  const paths = new Map(activeConfigMutationLocks.getStore()?.paths);
  for (const configPath of configPaths) {
    paths.set(configPath, scope);
  }
  const assertScopedCurrent = composeConfigWriteAssertions(() => {
    if (!scope.active) {
      throw new Error("Config source ownership has closed.");
    }
  }, assertCurrent);
  try {
    return await activeConfigMutationLocks.run({ paths, current: scope }, async () => {
      let outcome: { value: T } | { error: unknown };
      try {
        assertScopedCurrent();
        outcome = { value: await fn(assertScopedCurrent) };
      } catch (error) {
        outcome = { error };
      } finally {
        scope.accepting = false;
      }
      const failures: unknown[] = [];
      // Join work still pending when the callback settles. Earlier, reconciled
      // failures belong to the caller; drainage failures must not become success.
      // The source lock and captured executor guard remain live through this join.
      while (scope.pending.size > 0) {
        for (const result of await Promise.allSettled(scope.pending)) {
          if (result.status === "rejected") {
            failures.push(result.reason);
          }
        }
      }
      if (failures.length) {
        throw new AggregateError(
          "error" in outcome ? [outcome.error, ...failures] : failures,
          "Config write operation did not settle successfully.",
        );
      }
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.value;
    });
  } finally {
    scope.active = false;
  }
}

export async function withConfigWriteLock<T>(
  pathname: string,
  fn: () => Promise<T>,
  env?: NodeJS.ProcessEnv,
  assertCurrent?: () => void,
): Promise<T> {
  if (activeConfigMutationLocks.getStore()?.current.sourceOnly) {
    throw new Error("Config writes are not allowed inside a config source scope.");
  }
  const configPath = path.resolve(pathname);
  assertConfigWriteAllowedInCurrentMode({ configPath, env });
  const assertResourceUnborrowed = (targetPath: string) =>
    createManagedHandoffLeaseStore().assertSourceUnborrowed(targetPath);
  assertResourceUnborrowed(configPath);
  const inherited = activeConfigMutationLocks.getStore();
  const guardedParent = [...(inherited?.paths.entries() ?? [])].find(
    ([, scope]) => scope.assertCurrent,
  );
  const parentGuard = guardedParent ? captureConfigWriteLockGuard(guardedParent[0]) : undefined;
  if (parentGuard && !inherited?.current.accepting) {
    throw new Error("Config write source admission has closed.");
  }
  const doctorAuthority = getUpdateDoctorConfigWriteAuthority(configPath);
  const guard =
    assertCurrent || doctorAuthority
      ? composeConfigWriteAssertions(
          parentGuard,
          assertCurrent,
          doctorAuthority ? () => doctorAuthority.assertCurrent() : undefined,
        )
      : captureConfigWriteLockGuard(configPath);
  guard?.();
  const inheritedScope = inherited?.paths.get(configPath);
  if (inheritedScope?.active) {
    const running = Promise.resolve().then(() => {
      // Borrower custody may have changed since this nested call was queued,
      // including for ordinary config writers without an explicit source guard.
      assertResourceUnborrowed(configPath);
      captureConfigWriteLockGuard(configPath)?.();
      return guard ? runConfigLockScope([configPath], fn, guard) : fn();
    });
    inheritedScope.pending.add(running);
    try {
      return await running;
    } finally {
      inheritedScope.pending.delete(running);
    }
  }
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  return await enqueueConfigMutation(configPath, async () => {
    return await withFileLock(
      configPath,
      { ...CONFIG_MUTATION_LOCK_OPTIONS, assertResourceUnborrowed },
      () => runConfigLockScope([configPath], fn, guard),
    );
  }).catch(async (error: unknown) => {
    recordUpdateDoctorConfigWriteRefusal({
      reason: "config-lock-refused",
      message: formatErrorMessage(error),
      keys: [],
    });
    if (!(await isPermissionErrorInDirectory(error, configDir))) {
      throw error;
    }
    throw new Error(
      `OpenClaw cannot write to the config directory ${configDir}. Fix its ownership or permissions, then try again. Underlying error: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  });
}

/** Hold all config sources without waiting for another lock while retaining a partial set. */
export async function withConfigSourceLocks<T>(
  paths: readonly string[],
  run: (assertCurrent: () => void) => Promise<T>,
  env?: NodeJS.ProcessEnv,
  assertCurrent?: () => void,
): Promise<T> {
  if (activeConfigMutationLocks.getStore()) {
    throw new Error("Config source locks require an independent config scope.");
  }
  const requested = [...new Set(paths.map((pathname) => path.resolve(pathname)))];
  if (requested.length === 0) {
    throw new Error("Config source locks require at least one source path.");
  }
  const assertions = requested.map((configPath) => {
    assertConfigWriteAllowedInCurrentMode({ configPath, env });
    const doctorAuthority = getUpdateDoctorConfigWriteAuthority(configPath);
    return doctorAuthority ? () => doctorAuthority.assertCurrent() : undefined;
  });
  const callerGuard = composeConfigWriteAssertions(assertCurrent, ...assertions);
  const assertResourceUnborrowed = (targetPath: string) => {
    createManagedHandoffLeaseStore().assertSourceUnborrowed(targetPath);
  };
  callerGuard();
  requested.forEach(assertResourceUnborrowed);
  const parents = new Map(
    await Promise.all(
      [...new Set(requested.map((configPath) => path.dirname(configPath)))].map(async (parent) => {
        callerGuard();
        await fs.mkdir(parent, { recursive: true, mode: 0o700 });
        return [parent, await readDirectoryIdentity(await fs.realpath(parent))] as const;
      }),
    ),
  );
  const guard = composeConfigWriteAssertions(callerGuard, () => {
    for (const [parent, identity] of parents) {
      assertDirectoryIdentitySync(realpathSync.native(parent), identity);
    }
  });
  const filePaths = [
    ...new Set(
      requested.map((configPath) =>
        path.join(parents.get(path.dirname(configPath))!.realPath, path.basename(configPath)),
      ),
    ),
  ].toSorted();
  const queuePaths = [...new Set([...requested, ...filePaths])].toSorted();
  const lockOptions = { ...CONFIG_MUTATION_LOCK_OPTIONS, assertResourceUnborrowed };
  for (;;) {
    guard();
    let contended = queuePaths.find((pathname) => queuedConfigMutations.has(pathname));
    if (!contended) {
      const released = createDeferredCore();
      // Reserve the complete key set in one turn; later writers keep their normal FIFO place.
      const reservations = queuePaths.map((pathname) =>
        enqueueConfigMutation(pathname, () => released.promise),
      );
      const locks: FileLockHandle[] = [];
      const heldLockPaths = new Set<string>();
      const failures: unknown[] = [];
      let outcome: { value: T } | undefined;
      try {
        for (const pathname of filePaths) {
          guard();
          let alreadyHeld = false;
          if (heldLockPaths.size > 0) {
            const sidecar = `${pathname}.lock`;
            try {
              // Different target spellings can address the same ordinary sidecar.
              alreadyHeld =
                (await fs.lstat(sidecar)).isFile() && heldLockPaths.has(await fs.realpath(sidecar));
            } catch (error) {
              if (!isMissingPathError(error)) {
                throw error;
              }
            }
          }
          guard();
          if (alreadyHeld) {
            continue;
          }
          let lock: FileLockHandle;
          try {
            lock = await acquireFileLock(pathname, {
              ...lockOptions,
              retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
            });
          } catch (error) {
            if (isErrno(error) && error.code === FILE_LOCK_TIMEOUT_ERROR_CODE) {
              contended = pathname;
              break;
            }
            throw error;
          }
          locks.push(lock);
          heldLockPaths.add(await fs.realpath(lock.lockPath));
          guard();
        }
        if (!contended) {
          outcome = {
            value: await runConfigLockScope(queuePaths, run, guard, true),
          };
        }
      } catch (error) {
        failures.push(error);
      } finally {
        for (const lock of locks.toReversed()) {
          try {
            await lock.release();
          } catch (error) {
            failures.push(error);
          }
        }
        released.resolve();
        await Promise.all(reservations);
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Config source ownership did not settle successfully.");
      }
      if (outcome) {
        return outcome.value;
      }
    }
    // A root/include inversion can now finish: no other path remains reserved or locked.
    await enqueueConfigMutation(contended!, () =>
      withFileLock(contended!, lockOptions, async () => guard()),
    );
  }
}

export function markActiveConfigMutationPath(configPath: string): void {
  if (activeConfigMutationLocks.getStore()?.current.sourceOnly) {
    throw new Error("Config writes are not allowed inside a config source scope.");
  }
  captureConfigWriteLockGuard(configPath)?.();
  const scope = activeConfigMutationLocks.getStore();
  if (scope?.current.active) {
    scope.paths.set(path.resolve(configPath), scope.current);
  }
}

async function isPermissionErrorInDirectory(error: unknown, directory: string): Promise<boolean> {
  if (
    !isErrno(error) ||
    (error.code !== "EACCES" && error.code !== "EPERM" && error.code !== "EROFS")
  ) {
    return false;
  }
  const failedPath = error.path;
  if (typeof failedPath !== "string") {
    return false;
  }
  const failedDir = path.dirname(path.resolve(failedPath));
  if (failedDir === directory) {
    return true;
  }
  // Node reports the canonical path, so a config directory reached through a symlink (a macOS
  // /var -> /private/var home, for one) never matches the raw string. Resolve only on mismatch to
  // keep the successful write path free of an extra syscall.
  const canonicalDirectory = await fs.realpath(directory).catch(() => undefined);
  return canonicalDirectory !== undefined && failedDir === canonicalDirectory;
}
