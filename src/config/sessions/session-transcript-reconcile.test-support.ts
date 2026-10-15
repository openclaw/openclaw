import type { MessagePort, Worker, WorkerOptions } from "node:worker_threads";
import { afterEach, vi } from "vitest";
import type {
  SessionTranscriptReconcileWorkerInput,
  SessionTranscriptReconcileWorkerMessage,
} from "./session-transcript-reconcile.worker.js";

type WorkerTask = {
  worker: Worker;
  port: MessagePort;
  input: SessionTranscriptReconcileWorkerInput;
  taskId: number;
  observeMessage: (listener: (message: SessionTranscriptReconcileWorkerMessage) => void) => void;
};

const observer = vi.hoisted(() => ({
  workers: new Set<Worker>(),
  parents: new WeakMap<MessagePort, Pick<WorkerTask, "port" | "observeMessage">>(),
  beforeCreate: undefined as
    | ((
        filename: string | URL,
        options: WorkerOptions,
      ) => { filename: string | URL; options: WorkerOptions } | undefined)
    | undefined,
  onTask: undefined as ((task: WorkerTask) => void) | undefined,
}));

export async function createObservedWorkerThreads() {
  const actual = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
  return {
    ...actual,
    MessageChannel: class extends actual.MessageChannel {
      constructor() {
        super();
        const listeners: Array<(message: SessionTranscriptReconcileWorkerMessage) => void> = [];
        this.port1.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
          for (const listener of listeners) {
            listener(message);
          }
        });
        observer.parents.set(this.port2, {
          port: this.port1,
          observeMessage: (listener) => listeners.push(listener),
        });
      }
    },
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options: WorkerOptions = {}) {
        const reconciliation = String(filename).includes("session-transcript-reconcile.worker");
        const prepared = reconciliation ? observer.beforeCreate?.(filename, options) : undefined;
        super(prepared?.filename ?? filename, prepared?.options ?? options);
        if (!reconciliation) {
          return;
        }
        observer.workers.add(this);
        const postMessage = this.postMessage.bind(this);
        this.postMessage = (message: unknown, transferList) => {
          // Observe the real task's parent port before transfer; the native worker and FIFO stay real.
          const task = message as {
            input: { input: SessionTranscriptReconcileWorkerInput; port: MessagePort };
            taskId: number;
          };
          const parent = observer.parents.get(task.input.port);
          if (parent) {
            observer.onTask?.({
              worker: this,
              ...parent,
              input: task.input.input,
              taskId: task.taskId,
            });
          }
          postMessage(message, transferList);
        };
      }
    },
  };
}

export function useReconcileWorkerObserver() {
  afterEach(async () => {
    observer.onTask = undefined;
    observer.beforeCreate = undefined;
    await Promise.all([...observer.workers].map((worker) => worker.terminate()));
    observer.workers.clear();
  });
  return observer;
}
