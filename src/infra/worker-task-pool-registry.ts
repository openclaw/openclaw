import { joinOwnedWorkerTasks } from "@openclaw/worker-runtime";
import type { RetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { assertOpenClawAgentWriterReleased } from "../state/openclaw-agent-write-admission-state.js";

type ResourceOwningPool = { startCloseResources(key?: string): RetainedOperation<void> };

const livePools = resolveGlobalSingleton(
  Symbol.for("openclaw.workerTaskPools"),
  () => new Set<ResourceOwningPool>(),
);

export const liveWorkerTaskPools = {
  register<T extends ResourceOwningPool>(pool: T): T {
    livePools.add(pool);
    return pool;
  },
  async close(
    pool: ResourceOwningPool,
    closures: readonly Promise<void>[],
    finish: () => Promise<void>,
  ): Promise<void> {
    await joinOwnedWorkerTasks(closures);
    await finish();
    livePools.delete(pool);
  },
};

async function closeResources(key: string): Promise<void> {
  const results = await Promise.allSettled(
    [...livePools].map((pool) => pool.startCloseResources(key).result),
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
