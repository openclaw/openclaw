import { EventEmitter } from "node:events";
import type { MessagePort, WorkerOptions } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

type PostedTask = {
  input?: string;
  taskId?: number;
  responseId?: number;
  closeResource?: true;
  resourcePort?: MessagePort;
};

export type MockWorker<Task> = EventEmitter & {
  options?: WorkerOptions;
  posted: ReturnType<typeof vi.fn<(message: Task) => void>>;
  postMessage: (message: Task) => void;
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
};
export type FakeWorker = MockWorker<PostedTask>;

export function createMockWorkerClass<Task>(
  workers: MockWorker<Task>[],
  onPost: (worker: MockWorker<Task>, message: Task) => void = () => {},
) {
  return class extends EventEmitter {
    constructor(
      _url: URL,
      readonly options: WorkerOptions,
    ) {
      super();
      workers.push(this);
    }
    posted = vi.fn((message: Task) => onPost(this, message));
    postMessage = this.posted;
    ref() {}
    unref() {}
    terminate = vi.fn(async () => {
      this.emit("exit", 0);
      return 0;
    });
  };
}

export function reply(worker: FakeWorker, input: string, value = input): void {
  const task = expectDefined(
    worker.posted.mock.calls.find(([posted]) => posted.input === input)?.[0],
    `posted ${input}`,
  );
  worker.emit("message", { status: "ok", taskId: task.taskId, value });
}

export function request(worker: FakeWorker, input: string, id = 1): void {
  const posted = expectDefined(
    worker.posted.mock.calls.find(([task]) => task.input === input)?.[0],
    `posted ${input}`,
  );
  worker.emit("message", { status: "request", taskId: posted.taskId, id, value: id });
}

export function holdExit(worker: Pick<FakeWorker, "emit" | "terminate">) {
  const entered = createDeferredCore();
  const exit = createDeferredCore();
  worker.terminate.mockImplementationOnce(async () => {
    entered.resolve();
    await exit.promise;
    worker.emit("exit", 0);
    return 0;
  });
  return {
    entered: entered.promise,
    release: () => exit.resolve(),
    reject: (error: Error) => exit.reject(error),
  };
}
