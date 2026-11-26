import { MessageChannel } from "node:worker_threads";
import type { WorkerTaskHost } from "@openclaw/worker-runtime";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { captureDeletedAgentDatabaseFences } from "./agent-database-readers.js";
import { getDatabaseEngineSelection } from "./database-engine/context.js";
import { resolveNodeCompileCacheEnv } from "./node-compile-cache-env.js";
import { createPostgresPoolEndpoints, postgresPoolTransferList } from "./postgres-sync/pool.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import {
  claimsSharedHostSlot,
  createHostedWorker,
  isHostedWorkerEndpoint,
} from "./shared-worker-host.js";
import { trackSqliteDatabaseAdmissionWorker } from "./sqlite-database-admission.js";
import { readSqliteDatabaseAdmissionDeadline } from "./sqlite-worker-database-admission-relay.js";
import {
  createSqliteDatabaseAdmissionRelay,
  type SqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import { classifyWorkerRequest } from "./sqlite-worker-request-class.js";
import {
  attributeWorkerToPool,
  createCpuTrackedWorker,
  flushWorkerDiagnostics,
  markWorkerRetirement,
  receiveWorkerMemoryPort,
  isWorkerGcObservationEnabled,
} from "./worker-cpu.js";
import { createWorkerPoolMemoryBudget } from "./worker-memory-budget.js";
import { recordWorkerMessage } from "./worker-message-metrics.js";
import {
  captureRetainedNativeWorkerSource,
  createRetainedNativeWorker,
} from "./worker-native-lifecycle.js";
import { resolveWorkerPoolSize, type WorkerPoolClass } from "./worker-pool-sizing.js";
import { captureWorkerStartObserver, trackWorkerRequest } from "./worker-request-diagnostics.js";
import { workerRequestKind } from "./worker-request-kind.js";
import { getWorkerComputeCapacity } from "./worker-task-capacity.js";
import { liveWorkerTaskPools } from "./worker-task-pool-registry.js";
import type { WorkerTaskPoolOwnerOptions } from "./worker-task-pool.types.js";
import type { WorkerTaskContext } from "./worker-task-transport.js";

// Diagnostics project a closed vocabulary, not arbitrary SDK task fields.
const diagnosticTaskKinds = new Set([
  "prepare",
  "prepare-session",
  "transcript-stats",
  "session-entries",
  "session-cleanup",
  "session-memory-capture",
  "history-page",
  "historical-eviction-candidates",
  "usage-cost",
  "model-context",
  "context-messages",
  "transcript-search",
  "session-target-prepare",
  "session-store-target",
  "session-target-inventory",
  "combined-store-topology",
]);

const prepareResources = createLazyRuntimeModule(() => import("./temp-artifact-cleanup.js"));
const admissions = resolveGlobalSingleton(
  Symbol.for("openclaw.workerTaskDatabaseAdmissionChannels"),
  () =>
    new Map<
      Parameters<WorkerTaskHost["captureTaskContext"]>[0],
      {
        owner: SqliteWorkerOperationAdmission;
        sent: boolean;
        retiring: boolean;
        postgresSent?: boolean;
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
    createMemoryBudget: (pool, url, maxWorkers) =>
      createWorkerPoolMemoryBudget(pool, url, maxWorkers, !owner.nativeResource),
    requiresReady: owner.retainedTransport,
    createWorker(url, options) {
      const workerOptions = { execArgv: resolveRuntimeWorkerThreadExecArgv(url), ...options };
      if (workerOptions.env === undefined) {
        workerOptions.env = resolveNodeCompileCacheEnv();
      }
      if (boundedHeap) {
        const limits = workerOptions.resourceLimits;
        workerOptions.resourceLimits = {
          maxOldGenerationSizeMb: limits?.maxOldGenerationSizeMb ?? 512,
          maxYoungGenerationSizeMb: limits?.maxYoungGenerationSizeMb,
          codeRangeSizeMb: limits?.codeRangeSizeMb,
          stackSizeMb: limits?.stackSizeMb,
        };
      }
      // Lean: the first slot of a core kind is a logical endpoint of the shared host.
      if (!owner.nativeResource && claimsSharedHostSlot(url)) {
        const hosted = createHostedWorker(url, workerOptions, {
          ready: owner.retainedTransport === true,
        });
        return owner.retainedTransport ? { worker: hosted, native: hosted } : { worker: hosted };
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
      workers.find((worker) => !isHostedWorkerEndpoint(worker))?.service();
      // Hosted endpoints use their own ports, outside that source.
      for (const worker of workers) {
        if (isHostedWorkerEndpoint(worker)) {
          worker.service();
        }
      }
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
          sent: false,
          retiring: false,
        };
        admissions.set(worker, admission);
      }
      // The retained relay supplies current facts on demand; global snapshots grow with sessions.
      const selection = getDatabaseEngineSelection();
      const context: WorkerTaskContext = {
        collectWorkerMetrics: isWorkerGcObservationEnabled(),
        ...(selection ? { databaseEngineSelection: selection } : {}),
        deletedAgentDatabaseFences: captureDeletedAgentDatabaseFences(),
        databaseAdmissionDeadlineAtMs: readSqliteDatabaseAdmissionDeadline(),
        ...(!admission.sent ? { databaseAdmissionPort: admission.owner.port } : {}),
      };
      if (!admission.postgresSent) {
        context.postgresPool = createPostgresPoolEndpoints();
        admission.postgresSent = context.postgresPool !== undefined;
      }
      admission.sent = true;
      return context;
    },
    taskContextTransferList(context) {
      // SAFETY: The pool passes the context returned by this host's capture method.
      const captured = context as WorkerTaskContext;
      const transfers = postgresPoolTransferList(captured.postgresPool);
      return captured.databaseAdmissionPort
        ? [captured.databaseAdmissionPort, ...transfers]
        : transfers;
    },
    createTaskObserver(url) {
      const kind = workerRequestKind(url);
      return (operation) =>
        trackWorkerRequest(
          kind,
          operation === undefined ? "task" : classifyWorkerRequest(operation),
        );
    },
    describeTask(url, input, diagnosticOperation) {
      if (diagnosticOperation !== undefined) {
        const operation = diagnosticTaskKinds.has(diagnosticOperation)
          ? diagnosticOperation
          : classifyWorkerRequest(diagnosticOperation);
        return `${workerRequestKind(url)}.${operation}`;
      }
      // Inspect a data property only: diagnostics must not execute an input getter.
      const kind: unknown =
        input !== null && typeof input === "object"
          ? Object.getOwnPropertyDescriptor(input, "kind")?.value
          : undefined;
      const operation = typeof kind === "string" && diagnosticTaskKinds.has(kind) ? kind : "task";
      return `${workerRequestKind(url)}.${operation}`;
    },
    receiveMessage: receiveWorkerMemoryPort,
    observeResourceReply: () => recordWorkerMessage("resource", "from_worker"),
    captureWorkerStartObserver,
    workerStarted(worker, pool, cap, options, policyOwner) {
      if (isHostedWorkerEndpoint(worker)) {
        // The physical host owns admission tracking and the worker census entry.
        worker.pool = pool;
        return;
      }
      // Read-only connections also retain admission references until their worker exits.
      trackSqliteDatabaseAdmissionWorker(worker);
      attributeWorkerToPool(worker, pool, workerClass, {
        floor: policyOwner.retainOneIdleWorker ? 1 : 0,
        cap,
        pointReadCap: cap + 1,
        idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
        burstIdleTimeoutMs: options.burstIdleTimeoutMs,
      });
    },
    workerRetiring(worker, reason) {
      if (isHostedWorkerEndpoint(worker)) {
        worker.retiring(reason);
      }
      const admission = admissions.get(worker);
      if (admission) {
        // Final facts still settle over this channel, but retirement cannot create a new file.
        admission.retiring = true;
      }
      markWorkerRetirement(worker, reason);
    },
    workerStopped(worker) {
      const admission = admissions.get(worker);
      if (admission) {
        admission.retiring = true;
        const finishing = admission.owner.finish();
        if (finishing) {
          return finishing.then(() => {
            admissions.delete(worker);
          });
        }
        admissions.delete(worker);
      }
      return undefined;
    },
    flushWorkerDiagnostics,
    computeCapacity: getWorkerComputeCapacity(),
    pools: liveWorkerTaskPools,
  };
}
