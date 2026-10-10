import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  OpenClawStateLeaseError,
  withOpenClawStateLease,
  withOpenClawStateLeaseAsync,
  type OpenClawStateLeaseContext,
} from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createPluginCache,
  retirePluginCache,
  waitForPluginCacheRetirement,
  withPluginCache,
} from "./plugin-cache.js";
import { PLUGIN_LIFECYCLE_LEASE_IDENTITY } from "./plugin-lifecycle-lease-identity.js";

const DEFAULT_PLUGIN_LIFECYCLE_LEASE_MS = 5 * 60_000;
const DEFAULT_PLUGIN_LIFECYCLE_WAIT_MS = 10 * 60_000;

export type PluginLifecycleLeaseContext = Omit<OpenClawStateLeaseContext, "assertOwned"> & {
  assertOwned: () => void;
  databasePath: string;
  /** Original state owner; wrapper identity cannot authorize worker writes. */
  stateLease: OpenClawStateLeaseContext;
  /** Live requester checks without synchronous lease SQL inside worker admission. */
  assertCurrent(): void;
};

type PluginLifecycleRefusal = { current?: { error: unknown } };

// Escaped lease capabilities must not capture the operation's cache-owning activation.
function createPluginLifecycleLeaseContext(
  databasePath: string,
  lease: OpenClawStateLeaseContext,
  assertAuthority: (check: () => void) => void,
): PluginLifecycleLeaseContext {
  return {
    databasePath,
    stateLease: lease,
    assertCurrent: () => assertAuthority(() => lease.signal.throwIfAborted()),
    signal: lease.signal,
    ...(lease.renew ? { renew: () => lease.renew?.() } : {}),
    assertOwned: () => lease.assertOwned(),
    assertOwnedInTransaction: (database) => lease.assertOwnedInTransaction(database),
  };
}

type ActivePluginLifecycleLease = {
  databasePath: string;
  lease: PluginLifecycleLeaseContext;
  refusal: PluginLifecycleRefusal;
};

type PluginLifecycleLeaseOptions = Pick<
  OpenClawStateDatabaseOptions,
  "env" | "path" | "database"
> & {
  schemaPolicy?: "existing";
  signal?: AbortSignal;
  leaseMs?: number;
  waitMs?: number;
  /** Opt in only when protected mutations cannot outlive this process. */
  processBound?: boolean;
  /** Additional live caller authority; never replaces the plugin lease. */
  assertCurrent?: () => void;
};

const activePluginLifecycleLease = new AsyncLocalStorage<ActivePluginLifecycleLease>();
const lifecycleLeaseDemand = new Map<
  string,
  { acquisitions: number; holders: number; waiters: number }
>();

/** Lease holders use this to stop waiting on work that may be queued behind their lease. */
export function hasPluginLifecycleLeaseDemand(): boolean {
  return [...lifecycleLeaseDemand.values()].some(
    ({ holders, waiters }) => holders > 0 && waiters > 0,
  );
}

export function hasPluginLifecycleLease(): boolean {
  return activePluginLifecycleLease.getStore() !== undefined;
}

/** Detached observers must acquire ownership rather than borrow their writer's lease. */
export function runOutsidePluginLifecycleLease<T>(run: () => T): T {
  return activePluginLifecycleLease.exit(run);
}

function resolveLifecycleLeaseEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const requested = env ?? process.env;
  if (!process.env.VITEST || requested.VITEST || requested.OPENCLAW_STATE_DIR) {
    return requested;
  }
  return {
    ...requested,
    VITEST: process.env.VITEST,
    VITEST_WORKER_ID: process.env.VITEST_WORKER_ID,
    VITEST_POOL_ID: process.env.VITEST_POOL_ID,
  };
}

/** Keep reload's deadlock escape aware of both runtime writers and filesystem cleanup. */
async function withPluginLifecycleLeaseDemand<T>(
  databasePath: string,
  waitMs: number,
  run: (markAcquired: () => void) => Promise<T>,
): Promise<T> {
  const demand = lifecycleLeaseDemand.get(databasePath) ?? {
    acquisitions: 0,
    holders: 0,
    waiters: 0,
  };
  lifecycleLeaseDemand.set(databasePath, demand);
  demand.acquisitions += 1;
  let waiting = waitMs > 0;
  let acquired = false;
  demand.waiters += Number(waiting);
  const stopWaiting = () => {
    if (waiting) {
      waiting = false;
      demand.waiters -= 1;
    }
  };
  try {
    return await run(() => {
      stopWaiting();
      acquired = true;
      demand.holders += 1;
    });
  } finally {
    stopWaiting();
    demand.holders -= Number(acquired);
    demand.acquisitions -= 1;
    if (demand.acquisitions === 0) {
      lifecycleLeaseDemand.delete(databasePath);
    }
  }
}

/** Standalone retired-file cleanup uses worker-owned acquisition, verification and release. */
export async function withPluginArtifactCleanupLease<T>(
  options: Pick<PluginLifecycleLeaseOptions, "env" | "signal" | "assertCurrent">,
  run: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (hasPluginLifecycleLease()) {
    throw new Error("Plugin artifact cleanup must run outside runtime lifecycle work");
  }
  const context = captureOpenClawStateWorkerContext({
    env: resolveLifecycleLeaseEnv(options.env),
  });
  let refusal: { error: unknown } | undefined;
  const assertCurrent = () => {
    if (refusal) {
      throw refusal.error;
    }
    try {
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
    } catch (error) {
      refusal = { error };
      throw error;
    }
  };
  assertCurrent();
  return await withPluginLifecycleLeaseDemand(
    context.admission.databasePath,
    DEFAULT_PLUGIN_LIFECYCLE_WAIT_MS,
    (markAcquired) =>
      withOpenClawStateLeaseAsync(
        {
          ...PLUGIN_LIFECYCLE_LEASE_IDENTITY,
          leaseMs: DEFAULT_PLUGIN_LIFECYCLE_LEASE_MS,
          waitMs: DEFAULT_PLUGIN_LIFECYCLE_WAIT_MS,
          signal: options.signal,
          processBound: true,
          heartbeat: "worker",
          leaseLabel: "plugin lifecycle lease",
          operationLabel: "plugins.lifecycle.lease",
        },
        context,
        async (lease) => {
          markAcquired();
          const assertOwned = async () => {
            assertCurrent();
            try {
              await lease.assertOwned();
              assertCurrent();
            } catch (error) {
              refusal ??= { error };
              throw refusal.error;
            }
          };
          await assertOwned();
          const result = await run(assertOwned);
          await assertOwned();
          return result;
        },
      ),
  );
}

/** Serialize plugin artifact, install-index, and config mutations across processes. */
export async function withPluginLifecycleLease<T>(
  options: PluginLifecycleLeaseOptions,
  run: (lease: PluginLifecycleLeaseContext) => Promise<T>,
): Promise<T> {
  const active = activePluginLifecycleLease.getStore();
  const refusal: PluginLifecycleRefusal = active?.refusal ?? {};
  const assertAuthority = (check: () => void) => {
    if (refusal.current) {
      throw refusal.current.error;
    }
    try {
      check();
    } catch (error) {
      refusal.current = { error };
      throw error;
    }
  };
  const assertCurrent = options.assertCurrent;
  assertAuthority(() => assertCurrent?.());
  const runWithLease = async (lease: PluginLifecycleLeaseContext) => {
    const guard = (check: () => void) =>
      assertAuthority(() => {
        assertCurrent?.();
        check();
      });
    const owned: PluginLifecycleLeaseContext =
      !assertCurrent && lease === active?.lease
        ? lease
        : {
            ...lease,
            ...(lease.renew ? { renew: () => guard(() => lease.renew?.()) } : {}),
            assertCurrent: () => guard(() => lease.assertCurrent()),
            assertOwned: () => guard(() => lease.assertOwned()),
            assertOwnedInTransaction: (database) =>
              guard(() => lease.assertOwnedInTransaction(database)),
          };
    if (assertCurrent) {
      owned.assertOwned();
    }
    // Package settlement and nested metadata writers share the first refusal.
    // A recovered read cannot authorize rollback beneath retained inventory.
    return activePluginLifecycleLease.run(
      { databasePath: owned.databasePath, lease: owned, refusal },
      () => run(owned),
    );
  };
  if (
    active &&
    options.env === undefined &&
    options.path === undefined &&
    options.database === undefined
  ) {
    options.signal?.throwIfAborted();
    active.lease.assertOwned();
    return await runWithLease(active.lease);
  }

  const env = resolveLifecycleLeaseEnv(options.env);
  const databasePath = path.resolve(
    options.database?.path ?? options.path ?? resolveOpenClawStateSqlitePath(env),
  );
  if (active) {
    if (active.databasePath !== databasePath) {
      throw new OpenClawStateLeaseError(
        "nested plugin lifecycle lease cannot switch the shared state database",
        { code: "OPENCLAW_STATE_LEASE_INVALID_INPUT" },
      );
    }
    options.signal?.throwIfAborted();
    active.lease.assertOwned();
    return await runWithLease(active.lease);
  }

  const waitMs = options.waitMs ?? DEFAULT_PLUGIN_LIFECYCLE_WAIT_MS;
  return await withPluginLifecycleLeaseDemand(databasePath, waitMs, (markAcquired) =>
    withOpenClawStateLease(
      {
        ...PLUGIN_LIFECYCLE_LEASE_IDENTITY,
        database: {
          scope: "shared",
          schemaPolicy: options.schemaPolicy,
          options: {
            env,
            ...(options.path ? { path: options.path } : {}),
            ...(options.database ? { database: options.database } : {}),
          },
        },
        leaseMs: options.leaseMs ?? DEFAULT_PLUGIN_LIFECYCLE_LEASE_MS,
        waitMs,
        processBound: options.processBound,
        ...(options.signal ? { signal: options.signal } : {}),
        leaseLabel: "plugin lifecycle lease",
        operationLabel: "plugins.lifecycle.lease",
      },
      async (lease) => {
        markAcquired();
        const pluginLease = createPluginLifecycleLeaseContext(databasePath, lease, assertAuthority);
        // Capture fresh facts only after ownership: another process may have committed while we waited.
        const cache = createPluginCache();
        const failures: unknown[] = [];
        let result!: T;
        try {
          result = await withPluginCache(cache, () => runWithLease(pluginLease));
        } catch (error) {
          failures.push(error);
        }
        // Both owners must settle before releasing the lease, even when the operation or cleanup fails.
        for (const cleanup of [
          () => (cache.kind === "operation" ? retirePluginCache(cache) : undefined),
          waitForPluginCacheRetirement,
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "Plugin lifecycle work failed");
        }
        return result;
      },
    ),
  );
}
