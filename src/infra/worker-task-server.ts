import { MessagePort, type Transferable } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  serveOwnedWorkerTasks as serveRuntimeWorkerTasks,
  type WorkerTaskChannel,
  type WorkerTaskControl,
} from "@openclaw/worker-runtime/worker";
import { loggingState } from "../logging/state.js";
import {
  applyAgentDatabaseReaderRequest,
  decodeAgentDatabaseReaderRequest,
  installDeletedAgentDatabaseFences,
} from "./agent-database-readers.js";
import {
  installSqliteDatabaseAdmissions,
  withSqliteDatabaseAdmissionExchange,
} from "./sqlite-database-admission.js";
import {
  bindSqliteDatabaseAdmissionUpstream,
  exchangeSqliteDatabaseAdmissions,
} from "./sqlite-worker-database-admission-relay.js";
import { cancelWorkerIdleGc, scheduleWorkerIdleGc } from "./worker-idle-gc.js";
import { serveWorkerMemorySamples } from "./worker-memory.js";
import { WORKER_TASK_PORT_MESSAGE, type WorkerTaskContext } from "./worker-task-transport.js";

export type { WorkerTaskChannel } from "@openclaw/worker-runtime/worker";

type WorkerTaskHandler<Output> = (
  input: unknown,
  channel: WorkerTaskChannel | undefined,
  control: WorkerTaskControl,
) => Output | Promise<Output>;

/** Pool dispatch is serial per worker; handlers finish cleanup before returning their result. */
export function serveWorkerTasks<Output>(
  handler: WorkerTaskHandler<Output>,
  options: { transferList?: (value: Output) => Transferable[] } = {},
): void {
  serveOwnedWorkerTasks(handler, options);
}

/** Every served worker closes its agent database readers by path between tasks; owners may add more. */
export function serveOwnedWorkerTasks<Output>(
  handler: WorkerTaskHandler<Output>,
  options: {
    transferList?: (value: Output) => Transferable[];
    closeResource?: (key?: string) => void | Promise<void>;
    encodeResourceError?: (error: unknown) => unknown;
  } = {},
): void {
  let memoryPort: MessagePort;
  let taskPort: MessagePort | undefined;
  let databaseAdmissionPort: MessagePort | undefined;
  let memorySamplesStarted = false;
  const runWithDatabaseAdmission = async <T>(operation: () => T | Promise<T>): Promise<T> => {
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
  serveRuntimeWorkerTasks<Output, WorkerTaskContext>(
    (input, channel, control) => runWithDatabaseAdmission(() => handler(input, channel, control)),
    {
      ...options,
      closeResource: (key) =>
        runWithDatabaseAdmission(async () => {
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
        if (sampleMemory && !memorySamplesStarted) {
          memorySamplesStarted = true;
          serveWorkerMemorySamples(memoryPort);
        }
        cancelWorkerIdleGc();
      },
      installTaskContext(context) {
        installDeletedAgentDatabaseFences(context.deletedAgentDatabaseFences);
        installSqliteDatabaseAdmissions(context.databaseAdmissions);
        if (context.databaseAdmissionPort) {
          bindSqliteDatabaseAdmissionUpstream(context.databaseAdmissionPort);
        }
        databaseAdmissionPort ??= context.databaseAdmissionPort;
      },
      onIdle: scheduleWorkerIdleGc,
    },
  );
}
