import { MessageChannel } from "node:worker_threads";
import type { WorkerTaskHost } from "@openclaw/worker-runtime";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { captureDeletedAgentDatabaseFences } from "./agent-database-readers.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import {
  attributeWorkerToPool,
  createCpuTrackedWorker,
  markWorkerRetirement,
  receiveWorkerMemoryPort,
} from "./worker-cpu.js";
import {
  captureRetainedNativeWorkerSource,
  createRetainedNativeWorker,
} from "./worker-native-lifecycle.js";
import { getWorkerComputeCapacity } from "./worker-task-capacity.js";
import { liveWorkerTaskPools } from "./worker-task-pool-registry.js";
import type { WorkerTaskPoolOwnerOptions } from "./worker-task-pool.types.js";

const prepareResources = createLazyRuntimeModule(() => import("./temp-artifact-cleanup.js"));

export function createWorkerTaskHost(owner: WorkerTaskPoolOwnerOptions = {}): WorkerTaskHost {
  const source = owner.retainedTransport
    ? (owner.nativeSource ?? captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }))
    : undefined;
  return {
    createWorker(url, options) {
      const workerOptions = { execArgv: resolveRuntimeWorkerThreadExecArgv(url), ...options };
      if (owner.retainedTransport) {
        const { port1, port2 } = new MessageChannel();
        try {
          const native = createRetainedNativeWorker(
            url,
            workerOptions,
            source,
            owner.nativeResource,
            { host: port1, worker: port2 },
          );
          return { worker: native, native };
        } catch (error) {
          port1.close();
          port2.close();
          throw error;
        }
      }
      return { worker: createCpuTrackedWorker(url, workerOptions) };
    },
    prepareResources,
    async releaseTemporaryDirectory(directory) {
      const { removeTemporaryArtifacts } = await prepareResources();
      await removeTemporaryArtifacts(directory, "Worker task");
    },
    captureTaskContext: captureDeletedAgentDatabaseFences,
    receiveMessage: receiveWorkerMemoryPort,
    workerStarted: attributeWorkerToPool,
    workerRetiring: markWorkerRetirement,
    computeCapacity: getWorkerComputeCapacity(),
    pools: liveWorkerTaskPools,
  };
}
