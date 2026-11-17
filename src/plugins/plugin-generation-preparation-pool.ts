import { throwSettledAggregate } from "../infra/error-graph-internal.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { RetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { createOwnedWorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createPluginCaptureOwner } from "./plugin-capture-native-resource.client.js";
import type { createPluginGenerationNativeRoots } from "./plugin-generation-native-roots.js";
import type {
  GenerationWorkerInput,
  GenerationWorkerReply,
} from "./plugin-generation-worker-contract.js";

type PreparationPool = Awaited<ReturnType<typeof createPreparationPool>>;
type PreparationOwner = {
  closing: boolean;
  clients: Set<() => Promise<void>>;
  nextCaptureId: number;
  pool?: PreparationPool;
  preparingPool?: Promise<PreparationPool>;
};

export async function createPreparationPool(nativeSource: RetainedNativeWorkerSource) {
  const clients = new Map<
    number,
    {
      service(): void;
      releaseRoot(): Promise<void>;
      registerNativeRoot: ReturnType<typeof createPluginGenerationNativeRoots>["allocate"];
    }
  >();
  const captures = await createPluginCaptureOwner(nativeSource, {
    native(captureId, root) {
      const client = clients.get(captureId);
      if (!client) {
        throw new Error("Plugin capture host has closed");
      }
      return client.registerNativeRoot(root);
    },
  });
  let retired = false;
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.pluginGenerationPreparation);
  const pool = createOwnedWorkerTaskPool<GenerationWorkerInput, GenerationWorkerReply>(
    {
      workerUrl,
      maxWorkers: 1,
      idleTimeoutMs: 0,
      restartOnError: false,
      prepareWorker: () => ({
        options: {},
        releaseResources: async () => {
          retired = true;
          // Captured handles cannot migrate to a replacement isolate. Stop queued
          // captures before releasing roots they might otherwise still use.
          void pool.close(new Error("Plugin preparation worker has closed")).catch(() => {});
          const outcomes = await Promise.allSettled(
            [...clients.values()].map((client) => client.releaseRoot()),
          );
          throwSettledAggregate(outcomes, "Plugin preparation roots failed to close");
          await captures.close();
        },
      }),
    },
    { retainedTransport: true, nativeSource, nativeResource: captures.descriptor },
  );
  type Task = ReturnType<typeof pool.startTask>;
  const tasks = new Set<Task>();
  const releases = new WeakMap<Task, ReturnType<Task["release"]>>();
  const release = (task: Task) => {
    let released = releases.get(task);
    if (!released) {
      released = task.release();
      releases.set(task, released);
      void released.result.finally(() => tasks.delete(task)).catch(() => {});
    }
    return released;
  };
  return {
    pool,
    captures,
    clients,
    get retired() {
      return retired;
    },
    startTask(...args: Parameters<typeof pool.startTask>) {
      // A sibling's owner-controlled capture must not consume this call's deadline.
      const task = pool.startTask(args[0], { ...args[1], timeoutFrom: "dispatch" });
      tasks.add(task);
      // Physical task custody ends with its reply. Artifact custody continues until
      // its own disposal, independently of host-side admission publication.
      void task.result
        .then(
          () => release(task).result,
          () => release(task).result,
        )
        .catch(() => {});
      return task;
    },
    release,
    service() {
      for (const client of clients.values()) {
        client.service();
      }
      for (const task of tasks) {
        task.service();
        if (task.read().status !== "pending") {
          const released = release(task);
          released.service();
          if (released.read().status !== "pending") {
            tasks.delete(task);
          }
        }
      }
    },
  };
}
const preparationOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginPreparationOwners"),
  () => new WeakMap<RetainedNativeWorkerSource, PreparationOwner>(),
);

export function preparationOwnerFor(source: RetainedNativeWorkerSource): PreparationOwner {
  let owner = preparationOwners.get(source);
  if (!owner) {
    owner = { closing: false, clients: new Set(), nextCaptureId: 0 };
    preparationOwners.set(source, owner);
    const retained = owner;
    source.retain(owner, async () => {
      retained.closing = true;
      const shared = await (retained.preparingPool ?? retained.pool);
      const outcomes = await Promise.allSettled([...retained.clients].map((close) => close()));
      throwSettledAggregate(outcomes, "Plugin preparation workers failed to close");
      await shared?.pool.close();
      await shared?.captures.close();
    });
  }
  if (owner.closing) {
    throw new Error("Plugin preparation owner is closing");
  }
  return owner;
}
