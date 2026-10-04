import type { MessagePort, Transferable } from "node:worker_threads";
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
import { cancelWorkerIdleGc, scheduleWorkerIdleGc } from "./worker-idle-gc.js";
import { serveWorkerMemorySamples } from "./worker-memory.js";

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
  let memorySamplesStarted = false;
  serveRuntimeWorkerTasks<Output, [string, string][]>(
    handler,
    {
      ...options,
      closeResource: async (key) => {
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
      },
    },
    {
      initialize(port) {
        // Results use the host port; worker-local diagnostics must keep JSON stdout clean.
        loggingState.forceConsoleToStderr = true;
        memoryPort = port;
      },
      onMessage(sampleMemory) {
        if (sampleMemory && !memorySamplesStarted) {
          memorySamplesStarted = true;
          serveWorkerMemorySamples(memoryPort);
        }
        cancelWorkerIdleGc();
      },
      installTaskContext: installDeletedAgentDatabaseFences,
      onIdle: scheduleWorkerIdleGc,
    },
  );
}
