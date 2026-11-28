// Initialize the context-free root before a task can lazily import maintenance owners.
import "../shared/detached-async-context.js";
import { MessagePort, type Transferable } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  serveOwnedWorkerTasks as serveRuntimeWorkerTasks,
  type WorkerTaskHandler,
  type SynchronousWorkerTaskHandler,
} from "@openclaw/worker-runtime/worker";
import { scheduleOpenClawCompileCacheFlush } from "../../node-compile-cache.mjs";
import { loggingState } from "../logging/state.js";
import {
  applyAgentDatabaseReaderRequest,
  decodeAgentDatabaseReaderRequest,
  installDeletedAgentDatabaseFences,
} from "./agent-database-readers.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import type { DiagnosticWorkerRetainedData } from "./diagnostic-process-types.js";
import { bindPostgresPool, postgresPoolWorkerFailure } from "./postgres-sync/pool-state.js";
import {
  isSharedWorkerHostIsolate,
  runInHostedWorkerEndpoint,
  type HostedWorkerEndpoint,
  type HostedWorkerStart,
} from "./shared-worker-host-endpoint.js";
import { withSqliteDatabaseAdmissionExchange } from "./sqlite-database-admission-context.js";
import {
  bindSqliteDatabaseAdmissionUpstream,
  exchangeSqliteDatabaseAdmissions,
  withSqliteDatabaseAdmissionWait,
} from "./sqlite-worker-database-admission-relay.js";
import { cancelWorkerIdleGc, scheduleWorkerIdleGc } from "./worker-idle-gc.js";
import { serveWorkerMemorySamples } from "./worker-memory.js";
import { WORKER_TASK_PORT_MESSAGE, type WorkerTaskContext } from "./worker-task-transport.js";

export type { WorkerTaskChannel } from "@openclaw/worker-runtime/worker";

/** Pool dispatch is serial per worker; handlers finish cleanup before returning their result. */
export function serveWorkerTasks<Output, Input = unknown>(
  handler: WorkerTaskHandler<Output, Input> | SynchronousWorkerTaskHandler<Output, Input>,
  options: {
    transferList?: (value: Output) => Transferable[];
    retireOnError?: boolean;
    idleGc?: false;
    retainedData?: () => readonly DiagnosticWorkerRetainedData[];
  } = {},
): HostedWorkerStart {
  return serveOwnedWorkerTasks(handler, options);
}

type OwnedWorkerTaskServerOptions<Output> = {
  transferList?: (value: Output) => Transferable[];
  closeResource?: (key?: string) => void | Promise<void>;
  encodeResourceError?: (error: unknown) => unknown;
  /** Unknown native state cannot publish a reusable task failure before isolate exit. */
  retireOnError?: boolean;
  /** Guest runtimes own their heap budget and lifetime across task boundaries. */
  idleGc?: false;
  /** Cheap owner-held counts and size estimates; never contents, keys, or identities. */
  retainedData?: () => readonly DiagnosticWorkerRetainedData[];
  /**
   * Release every native resource this module retains between tasks. A shared-host endpoint
   * runs it before a logical stop, which otherwise would not release what isolate exit does.
   */
  releaseRetainedResources?: () => void | Promise<void>;
};

/**
 * Every served worker closes its agent database readers by path, between tasks except for
 * deleted-agent closes and revives; owners may add more.
 *
 * A standalone isolate serves its parent port at import. In the shared worker host, the
 * import serves nothing; the host calls the returned start once per logical endpoint.
 */
export function serveOwnedWorkerTasks<Output, Input = unknown>(
  handler: WorkerTaskHandler<Output, Input> | SynchronousWorkerTaskHandler<Output, Input>,
  options: OwnedWorkerTaskServerOptions<Output> = {},
): HostedWorkerStart {
  const start: HostedWorkerStart = (endpoint) => serve(handler, options, endpoint);
  if (!isSharedWorkerHostIsolate()) {
    serve(handler, options);
  }
  return start;
}

function serve<Output, Input>(
  handler: WorkerTaskHandler<Output, Input> | SynchronousWorkerTaskHandler<Output, Input>,
  options: OwnedWorkerTaskServerOptions<Output>,
  endpoint?: HostedWorkerEndpoint,
): void {
  let memoryPort: MessagePort;
  // A ready-acknowledged hosted endpoint already owns its task port.
  let taskPort: MessagePort | undefined = endpoint?.ready ? endpoint.port : undefined;
  let databaseAdmissionPort: MessagePort | undefined;
  let databaseAdmissionDeadlineAtMs: number | undefined;
  let databaseEngineSelection: WorkerTaskContext["databaseEngineSelection"];
  let memorySamples: ReturnType<typeof serveWorkerMemorySamples> | undefined;
  const runInEndpoint = <T>(operation: () => T): T =>
    endpoint ? runInHostedWorkerEndpoint(endpoint, operation) : operation();
  const runWithTaskContext = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const run = async () => {
      const port = databaseAdmissionPort;
      if (!port) {
        return operation();
      }
      let active = true;
      try {
        return await withSqliteDatabaseAdmissionExchange(
          (admissions, location, create, observedLocation) => {
            if (!active) {
              throw new Error("SQLite admission facts outlived their worker task");
            }
            return exchangeSqliteDatabaseAdmissions(
              port,
              admissions,
              location,
              create,
              observedLocation,
            );
          },
          operation,
        );
      } finally {
        active = false;
      }
    };
    // Offline ports reuse workers across engines; cleanup retains the last task's selection.
    return databaseEngineSelection
      ? withDatabaseEngineSelection(databaseEngineSelection, run)
      : run();
  };
  if (endpoint) {
    // The host stops only an idle endpoint, after it releases what isolate exit would have.
    endpoint.close = async () => {
      try {
        await runInEndpoint(() => options.releaseRetainedResources?.());
      } finally {
        databaseAdmissionPort?.close();
        endpoint.port.close();
      }
    };
  }
  serveRuntimeWorkerTasks<Output, WorkerTaskContext, Input>(
    typeof handler !== "function"
      ? handler
      : (input, channel, control) =>
          runInEndpoint(() =>
            withSqliteDatabaseAdmissionWait(
              {
                deadlineAtMs: databaseAdmissionDeadlineAtMs,
                assertActive: () => control.throwIfCancelled(),
              },
              () =>
                runWithTaskContext(async () => {
                  const result = await handler(input, channel, control);
                  // Some handlers encode database failures as results; their dead endpoints
                  // still require the same retirement as a thrown transport failure.
                  const failure = postgresPoolWorkerFailure();
                  if (failure) {
                    throw failure;
                  }
                  return result;
                }),
            ),
          ),
    {
      ...options,
      get retireOnError() {
        return options.retireOnError || postgresPoolWorkerFailure() !== undefined;
      },
      // The deletion fence is set before these closers run and matches only the deleted agent's
      // paths. A running read of that agent (an auth-profile or catalog read, for example) then
      // fails visibly instead of holding agents.delete behind it; the usual running task is
      // another agent's catalog build, which can take up to 180 s.
      closesBesideExecution: (key) => {
        const request = decodeAgentDatabaseReaderRequest(key);
        return request?.kind === "revive" || (request?.kind === "close" && request.deleted);
      },
      closeResource: (key) =>
        runInEndpoint(() =>
          runWithTaskContext(async () => {
            const request = decodeAgentDatabaseReaderRequest(key);
            if (!request && !options.closeResource) {
              throw new Error("Worker does not own retained resources");
            }
            if (request) {
              await applyAgentDatabaseReaderRequest(request);
            }
            if (!request || request.kind === "close") {
              await options.closeResource?.(key);
            }
          }),
        ),
    },
    {
      startupPort: endpoint?.port,
      onRetired: endpoint
        ? () => endpoint.fail("served module retired after a task failure")
        : undefined,
      selectStartupPort(message) {
        if (!isRecord(message) || message.type !== WORKER_TASK_PORT_MESSAGE) {
          return undefined;
        }
        if (!(message.port instanceof MessagePort)) {
          throw new Error("Retained worker task port is invalid");
        }
        taskPort = message.port;
        return taskPort;
      },
      initialize(port) {
        // Results use the host port; worker-local diagnostics must keep JSON stdout clean.
        loggingState.forceConsoleToStderr = true;
        memoryPort = port;
      },
      onReady() {
        taskPort?.postMessage({ status: "ready" }, []);
      },
      onMessage(sampleMemory) {
        // The host samples its one physical heap; endpoints never claim isolate memory.
        if (sampleMemory && !memorySamples && !endpoint) {
          memorySamples = serveWorkerMemorySamples(memoryPort, options.retainedData);
        }
        cancelWorkerIdleGc();
      },
      installTaskContext(context) {
        // Carry demand on the task itself so even its first synchronous work is observed.
        memorySamples?.setTaskMetrics(context.collectWorkerMetrics === true);
        databaseAdmissionDeadlineAtMs = context.databaseAdmissionDeadlineAtMs;
        databaseEngineSelection = context.databaseEngineSelection;
        if (context.postgresPool) {
          bindPostgresPool(context.postgresPool);
        }
        installDeletedAgentDatabaseFences(context.deletedAgentDatabaseFences);
        if (context.databaseAdmissionPort) {
          bindSqliteDatabaseAdmissionUpstream(context.databaseAdmissionPort, endpoint);
        }
        databaseAdmissionPort ??= context.databaseAdmissionPort;
      },
      onIdle() {
        // Later tasks can load additional modules; an empty native flush does no I/O.
        scheduleOpenClawCompileCacheFlush();
        if (options.idleGc !== false) {
          scheduleWorkerIdleGc();
        }
      },
      collectTaskDiagnostics: () => memorySamples?.collectTask(),
      onRetire() {
        cancelWorkerIdleGc();
        try {
          memorySamples?.close();
        } finally {
          // Exchanges are synchronous; the runtime already joined task cleanup and resource receipts.
          databaseAdmissionPort?.close();
        }
      },
    },
  );
}
