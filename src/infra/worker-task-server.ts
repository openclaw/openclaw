import { parentPort, type Transferable } from "node:worker_threads";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { createWorkerTaskControl, type WorkerTaskControl } from "./worker-task-native-sections.js";

type WorkerChannelResponse = { input: unknown; consumed: () => void };
type WorkerConversation = {
  taskId: number;
  responseId: number;
  pending?: Deferred<WorkerChannelResponse>;
};

/** A conversation never outlives the pool task or crosses worker generations. */
export type WorkerTaskChannel = {
  consumeInput: () => void;
  request: (
    value: unknown,
    transferList?: readonly Transferable[],
  ) => Promise<{ input: unknown; consumed: () => void }>;
};

/** Pool dispatch is serial per worker; handlers finish cleanup before returning their result. */
export function serveWorkerTasks<Output>(
  handler: (
    input: unknown,
    channel: WorkerTaskChannel | undefined,
    control: WorkerTaskControl,
  ) => Output | Promise<Output>,
  options: { transferList?: (value: Output) => Transferable[] } = {},
): void {
  const port = parentPort;
  if (!port) {
    return;
  }
  let active: WorkerConversation | undefined;
  port.on(
    "message",
    (message: {
      input: unknown;
      taskId: number;
      interactive?: boolean;
      responseId?: number;
      nativeSections: SharedArrayBuffer;
    }) => {
      if (message.responseId !== undefined) {
        if (
          !active ||
          message.taskId !== active.taskId ||
          message.responseId !== active.responseId ||
          !active.pending
        ) {
          throw new Error("stale worker task response");
        }
        const pending = active.pending;
        active.pending = undefined;
        let consumed = false;
        const taskId = message.taskId;
        const id = message.responseId;
        pending.resolve({
          input: message.input,
          consumed: () => {
            if (consumed) {
              return;
            }
            consumed = true;
            port.postMessage({ status: "consumed", taskId, id });
          },
        });
        return;
      }
      if (active) {
        throw new Error("overlapping worker tasks");
      }
      const task: WorkerConversation = { taskId: message.taskId, responseId: 0 };
      active = task;
      const control = createWorkerTaskControl(
        new Int32Array(message.nativeSections),
        () => active === task,
      );
      const channel: WorkerTaskChannel | undefined = message.interactive
        ? {
            consumeInput: () =>
              port.postMessage({ status: "consumed", taskId: task.taskId, id: 0 }),
            request: (value, transferList) => {
              if (active !== task || task.pending) {
                throw new Error("closed or busy worker channel");
              }
              task.pending = createDeferredCore();
              port.postMessage(
                {
                  status: "request",
                  taskId: task.taskId,
                  id: ++task.responseId,
                  value,
                },
                transferList ? [...transferList] : [],
              );
              return task.pending.promise;
            },
          }
        : undefined;
      void Promise.resolve()
        .then(() => {
          control.throwIfCancelled();
          return handler(message.input, channel, control);
        })
        .then((value) => {
          active = undefined;
          port.postMessage(
            { status: "ok", value, taskId: task.taskId },
            options.transferList?.(value) ?? [],
          );
        })
        .catch((error: unknown) => {
          active = undefined;
          port.postMessage({
            status: "failed",
            taskId: task.taskId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  );
}
