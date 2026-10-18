import { joinOwnedWorkerTasks, type ResourceOwningPool } from "@openclaw/worker-runtime";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { assertOpenClawAgentWriterReleased } from "../state/openclaw-agent-write-admission-state.js";

const livePools = resolveGlobalSingleton(
  Symbol.for("openclaw.workerTaskPools"),
  () => new Set<WeakRef<ResourceOwningPool>>(),
);

// Broadcast discovery must not keep an abandoned pool and its module graph alive.
function* reachablePools() {
  for (const reference of livePools) {
    const pool = reference.deref();
    if (pool) {
      yield { pool, reference };
    } else {
      livePools.delete(reference);
    }
  }
}

export const liveWorkerTaskPools = {
  register<T extends ResourceOwningPool>(pool: T): T {
    for (const entry of reachablePools()) {
      if (entry.pool === pool) {
        return pool;
      }
    }
    livePools.add(new WeakRef(pool));
    return pool;
  },
  async close(
    pool: ResourceOwningPool,
    closures: readonly Promise<void>[],
    finish: () => Promise<void>,
  ): Promise<void> {
    await joinOwnedWorkerTasks(closures);
    await finish();
    for (const entry of reachablePools()) {
      if (entry.pool === pool) {
        livePools.delete(entry.reference);
      }
    }
  },
};

async function closeResources(key: string): Promise<void> {
  const results = await Promise.allSettled(
    [...reachablePools()].map(({ pool }) => pool.startCloseResources(key).result),
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Worker resource cleanup failed");
  }
}

/** Ask every live pool's workers to close the retained resources this key names. */
export const closeWorkerTaskPoolResources =
  process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development"
    ? (key: string) => {
        assertOpenClawAgentWriterReleased("close process-wide reader resources");
        return closeResources(key);
      }
    : closeResources;
