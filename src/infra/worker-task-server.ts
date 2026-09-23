import { parentPort, type MessagePort, type Transferable } from "node:worker_threads";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { cancelWorkerIdleGc, scheduleWorkerIdleGc } from "./worker-idle-gc.js";
import {
  createWorkerTaskControl,
  observeWorkerTaskCancellation,
  withWorkerTaskNativeSectionScope,
  type WorkerTaskControl,
} from "./worker-task-native-sections.js";

type WorkerChannelResponse = { input: unknown; consumed: () => void };
type WorkerConversation = {
  taskId: number;
  responseId: number;
  pending?: Deferred<WorkerChannelResponse>;
  assertCurrent: () => void;
  cancelPending: (error: unknown) => void;
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
  serveOwnedWorkerTasks(handler, options);
}

/** Internal native owners additionally acknowledge resource cleanup between tasks. */
export function serveOwnedWorkerTasks<Output>(
  handler: (
    input: unknown,
    channel: WorkerTaskChannel | undefined,
    control: WorkerTaskControl,
  ) => Output | Promise<Output>,
  options: {
    transferList?: (value: Output) => Transferable[];
    closeResource?: (key?: string) => void;
  } = {},
): void {
  const port = parentPort;
  if (!port) {
    return;
  }
  let active: WorkerConversation | undefined;
  let execution = Promise.resolve();
  let resourceClosures = Promise.resolve();
  let cancelledResponse: { taskId: number; responseId: number } | undefined;
  port.on(
    "message",
    (message: {
      input: unknown;
      taskId: number;
      interactive?: boolean;
      responseId?: number;
      nativeSections: SharedArrayBuffer;
      closeResource?: true;
      key?: string;
      resourcePort?: MessagePort;
    }) => {
      cancelWorkerIdleGc();
      if (message.closeResource && message.resourcePort) {
        const receipt = message.resourcePort;
        const precedingExecution = execution;
        resourceClosures = resourceClosures
          .then(() => precedingExecution)
          .then(() => {
            if (!options.closeResource) {
              throw new Error("Worker does not own retained resources");
            }
            options.closeResource(message.key);
            receipt.postMessage({ ok: true }, []);
          })
          .catch((error: unknown) => {
            receipt.postMessage(
              {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
              [],
            );
          })
          .finally(() => {
            receipt.close();
            if (!active) {
              scheduleWorkerIdleGc();
            }
          });
        return;
      }
      if (message.responseId !== undefined) {
        if (
          message.taskId === cancelledResponse?.taskId &&
          message.responseId === cancelledResponse.responseId
        ) {
          return;
        }
        if (
          !active ||
          message.taskId !== active.taskId ||
          message.responseId !== active.responseId ||
          !active.pending
        ) {
          throw new Error("stale worker task response");
        }
        try {
          active.assertCurrent();
        } catch (error) {
          active.cancelPending(error);
          return;
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
      const nativeSections = new Int32Array(message.nativeSections);
      const task: WorkerConversation = {
        taskId: message.taskId,
        responseId: 0,
        assertCurrent: () => control.throwIfCancelled(),
        cancelPending: (error) => {
          const pending = task.pending;
          if (!pending) {
            return;
          }
          task.pending = undefined;
          cancelledResponse = { taskId: task.taskId, responseId: task.responseId };
          pending.reject(error);
        },
      };
      const control = createWorkerTaskControl(nativeSections, () => active === task);
      active = task;
      const stopObserving = message.interactive
        ? observeWorkerTaskCancellation(
            nativeSections,
            () => active === task,
            () => task.cancelPending(new Error("worker task cancelled")),
          )
        : undefined;
      const channel: WorkerTaskChannel | undefined = message.interactive
        ? {
            consumeInput: () =>
              port.postMessage({ status: "consumed", taskId: task.taskId, id: 0 }),
            request: (value, transferList) => {
              control.throwIfCancelled();
              if (active !== task || task.pending) {
                throw new Error("closed or busy worker channel");
              }
              const pending = createDeferredCore<WorkerChannelResponse>();
              task.pending = pending;
              try {
                const transfers = transferList ? [...transferList] : [];
                control.throwIfCancelled();
                port.postMessage(
                  {
                    status: "request",
                    taskId: task.taskId,
                    id: ++task.responseId,
                    value,
                  },
                  transfers,
                );
              } catch (error) {
                task.pending = undefined;
                pending.reject(error);
              }
              return pending.promise;
            },
          }
        : undefined;
      const precedingClosures = resourceClosures;
      execution = Promise.resolve()
        .then(async () => {
          try {
            await precedingClosures;
            control.throwIfCancelled();
            return await withWorkerTaskNativeSectionScope(
              nativeSections,
              () => active === task,
              () => handler(message.input, channel, control),
            );
          } finally {
            await stopObserving?.();
            active = undefined;
          }
        })
        .then((value) => {
          port.postMessage(
            { status: "ok", value, taskId: task.taskId },
            options.transferList?.(value) ?? [],
          );
        })
        .catch((error: unknown) => {
          port.postMessage({
            status: "failed",
            taskId: task.taskId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(scheduleWorkerIdleGc);
    },
  );
}
