import { MessageChannel } from "node:worker_threads";
import type { WorkerTaskHost } from "@openclaw/worker-runtime";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { captureDeletedAgentDatabaseFences } from "./agent-database-readers.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import {
  captureSqliteDatabaseAdmissions,
  createSqliteDatabaseAdmissionCursor,
  trackSqliteDatabaseAdmissionWorker,
  type SqliteDatabaseAdmissionCursor,
} from "./sqlite-database-admission.js";
import {
  createSqliteDatabaseAdmissionRelay,
  type SqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
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
import { resolveWorkerPoolSize, type WorkerPoolClass } from "./worker-pool-sizing.js";
import { classifyWorkerRequest, trackWorkerRequest } from "./worker-request-diagnostics.js";
import { workerRequestKind } from "./worker-request-kind.js";
import { getWorkerComputeCapacity } from "./worker-task-capacity.js";
import { liveWorkerTaskPools } from "./worker-task-pool-registry.js";
import type { WorkerTaskPoolOwnerOptions } from "./worker-task-pool.types.js";
import type { WorkerTaskContext } from "./worker-task-transport.js";

const prepareResources = createLazyRuntimeModule(() => import("./temp-artifact-cleanup.js"));
const admissions = resolveGlobalSingleton(
  Symbol.for("openclaw.workerTaskDatabaseAdmissionChannels"),
  () =>
    new Map<
      Parameters<WorkerTaskHost["captureTaskContext"]>[0],
      {
        owner: SqliteWorkerOperationAdmission;
        cursor: SqliteDatabaseAdmissionCursor;
        sent: boolean;
        retiring: boolean;
      }
    >(),
);

export function createWorkerTaskHost(
  owner: WorkerTaskPoolOwnerOptions = {},
  workerClass?: WorkerPoolClass,
): WorkerTaskHost {
  const boundedHeap = workerClass && workerClass !== "writer" && workerClass !== "singleton";
  const source = owner.retainedTransport
    ? (owner.nativeSource ?? captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }))
    : undefined;
  return {
    maxWorkers: workerClass ? resolveWorkerPoolSize(workerClass) : undefined,
    requiresReady: owner.retainedTransport,
    createWorker(url, options) {
      const workerOptions = { execArgv: resolveRuntimeWorkerThreadExecArgv(url), ...options };
      if (boundedHeap) {
        const limits = workerOptions.resourceLimits;
        workerOptions.resourceLimits = {
          maxOldGenerationSizeMb: limits?.maxOldGenerationSizeMb ?? 512,
          maxYoungGenerationSizeMb: limits?.maxYoungGenerationSizeMb,
          codeRangeSizeMb: limits?.codeRangeSizeMb,
          stackSizeMb: limits?.stackSizeMb,
        };
      }
      if (owner.retainedTransport) {
        const { port1, port2 } = new MessageChannel();
        const native = createRetainedNativeWorker(
          url,
          workerOptions,
          source,
          owner.nativeResource,
          { host: port1, worker: port2 },
        );
        return { worker: native, native };
      }
      return { worker: createCpuTrackedWorker(url, workerOptions) };
    },
    serviceNativeWorkers(workers) {
      // The shared native source can advance sibling pools while this caller cannot run events.
      for (const { owner: admission } of admissions.values()) {
        admission.service();
      }
      // This factory binds every native worker in the pool to the same captured source.
      workers[0]?.service();
    },
    prepareResources,
    async releaseTemporaryDirectory(directory) {
      const { removeTemporaryArtifacts } = await prepareResources();
      await removeTemporaryArtifacts(directory, "Worker task");
    },
    captureTaskContext(worker): WorkerTaskContext {
      let admission = admissions.get(worker);
      if (!admission) {
        admission = {
          owner: runInDetachedAsyncContext(() =>
            createSqliteDatabaseAdmissionRelay(() => {
              if (admissions.get(worker)?.retiring !== false) {
                throw new Error("SQLite creation relay's task worker is retiring");
              }
            }),
          ),
          cursor: createSqliteDatabaseAdmissionCursor(),
          sent: false,
          retiring: false,
        };
        admissions.set(worker, admission);
        const retained = admission;
        worker.once("exit", () => {
          retained.owner.finish();
          admissions.delete(worker);
        });
      }
      const context: WorkerTaskContext = {
        deletedAgentDatabaseFences: captureDeletedAgentDatabaseFences(),
        databaseAdmissions: captureSqliteDatabaseAdmissions(admission.cursor),
        ...(!admission.sent ? { databaseAdmissionPort: admission.owner.port } : {}),
      };
      admission.sent = true;
      return context;
    },
    taskContextTransferList(context) {
      // SAFETY: The pool passes the context returned by this host's capture method.
      const captured = context as WorkerTaskContext;
      return captured.databaseAdmissionPort ? [captured.databaseAdmissionPort] : [];
    },
    createTaskObserver(url) {
      const kind = workerRequestKind(url);
      return (operation) =>
        trackWorkerRequest(
          kind,
          operation === undefined ? "task" : classifyWorkerRequest(operation),
        );
    },
    receiveMessage: receiveWorkerMemoryPort,
    workerStarted(worker, pool) {
      trackSqliteDatabaseAdmissionWorker(worker);
      attributeWorkerToPool(worker, pool);
    },
    workerRetiring(worker, reason) {
      const admission = admissions.get(worker);
      if (admission) {
        // Final facts still settle over this channel, but retirement cannot create a new file.
        admission.retiring = true;
      }
      markWorkerRetirement(worker, reason);
    },
    computeCapacity: getWorkerComputeCapacity(),
    pools: liveWorkerTaskPools,
  };
}
