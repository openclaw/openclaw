// Initialize the context-free root before a task can lazily import maintenance owners.
import "../shared/detached-async-context.js";
import { MessagePort, type Transferable } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  serveOwnedWorkerTasks as serveRuntimeWorkerTasks,
  type WorkerTaskHandler,
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
import { withSqliteDatabaseAdmissionExchange } from "./sqlite-database-admission.js";
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
  handler: WorkerTaskHandler<Output, Input>,
  options: {
    transferList?: (value: Output) => Transferable[];
    retireOnError?: boolean;
    idleGc?: false;
    retainedData?: () => readonly DiagnosticWorkerRetainedData[];
  } = {},
): void {
  serveOwnedWorkerTasks(handler, options);
}

/** Every served worker closes its agent database readers by path between tasks; owners may add more. */
export function serveOwnedWorkerTasks<Output, Input = unknown>(
  handler: WorkerTaskHandler<Output, Input>,
  options: {
    transferList?: (value: Output) => Transferable[];
    closeResource?: (key?: string) => void | Promise<void>;
    encodeResourceError?: (error: unknown) => unknown;
    /** Unknown native state cannot publish a reusable task failure before isolate exit. */
    retireOnError?: boolean;
    /** Guest runtimes own their heap budget and lifetime across task boundaries. */
    idleGc?: false;
    /** Cheap owner-held counts and size estimates; never contents, keys, or identities. */
    retainedData?: () => readonly DiagnosticWorkerRetainedData[];
  } = {},
): void {
  let memoryPort: MessagePort;
  let taskPort: MessagePort | undefined;
  let databaseAdmissionPort: MessagePort | undefined;
  let databaseAdmissionDeadlineAtMs: number | undefined;
  let databaseEngineSelection: WorkerTaskContext["databaseEngineSelection"];
  let closeMemorySamples: (() => void) | undefined;
  const runWithTaskContext = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const run = async () => {
      const port = databaseAdmissionPort;
      if (!port) {
        return operation();
      }
      let active = true;
      try {
        return await withSqliteDatabaseAdmissionExchange((admissions, location, create) => {
          if (!active) {
            throw new Error("SQLite admission facts outlived their worker task");
          }
          return exchangeSqliteDatabaseAdmissions(port, admissions, location, create);
        }, operation);
      } finally {
        active = false;
      }
    };
    // Offline ports reuse workers across engines; cleanup retains the last task's selection.
    return databaseEngineSelection
      ? withDatabaseEngineSelection(databaseEngineSelection, run)
      : run();
  };
  serveRuntimeWorkerTasks<Output, WorkerTaskContext, Input>(
    (input, channel, control) =>
      withSqliteDatabaseAdmissionWait(
        {
          deadlineAtMs: databaseAdmissionDeadlineAtMs,
          assertActive: () => control.throwIfCancelled(),
        },
        () => runWithTaskContext(() => handler(input, channel, control)),
      ),
    {
      ...options,
      closeResource: (key) =>
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
    },
    {
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
        if (sampleMemory && !closeMemorySamples) {
          closeMemorySamples = serveWorkerMemorySamples(memoryPort, options.retainedData);
        }
        cancelWorkerIdleGc();
      },
      installTaskContext(context) {
        databaseAdmissionDeadlineAtMs = context.databaseAdmissionDeadlineAtMs;
        databaseEngineSelection = context.databaseEngineSelection;
        installDeletedAgentDatabaseFences(context.deletedAgentDatabaseFences);
        if (context.databaseAdmissionPort) {
          bindSqliteDatabaseAdmissionUpstream(context.databaseAdmissionPort);
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
      onRetire() {
        cancelWorkerIdleGc();
        try {
          closeMemorySamples?.();
        } finally {
          // Exchanges are synchronous; the runtime already joined task cleanup and resource receipts.
          databaseAdmissionPort?.close();
        }
      },
    },
  );
}
