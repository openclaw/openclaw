import type { EventEmitter } from "node:events";
import type { MessagePort } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import type { vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

export type PostedTask = {
  input?: string;
  taskId?: number;
  responseId?: number;
  closeResource?: true;
  resourcePort?: MessagePort;
};

export type FakeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn<(message: PostedTask) => void>>;
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
};

export function reply(worker: FakeWorker, input: string, value = input): void {
  const task = expectDefined(
    worker.postMessage.mock.calls.find(([posted]) => posted.input === input)?.[0],
    `posted ${input}`,
  );
  worker.emit("message", { status: "ok", taskId: task.taskId, value });
}

export function request(worker: FakeWorker, input: string, id = 1): void {
  const posted = expectDefined(
    worker.postMessage.mock.calls.find(([task]) => task.input === input)?.[0],
    `posted ${input}`,
  );
  worker.emit("message", { status: "request", taskId: posted.taskId, id, value: id });
}

export function holdExit(worker: FakeWorker) {
  const entered = createDeferredCore();
  const exit = createDeferredCore();
  worker.terminate.mockImplementationOnce(async () => {
    entered.resolve();
    await exit.promise;
    worker.emit("exit", 0);
    return 0;
  });
  return { entered: entered.promise, release: () => exit.resolve() };
}
