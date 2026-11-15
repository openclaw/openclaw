import type { Worker } from "node:worker_threads";
import { receiveWorkerMemoryPort } from "./worker-cpu.js";
export function waitForWorkerMemoryPort(worker: Worker) {
  return new Promise<void>((resolve, reject) => {
    worker.on("message", (message: unknown) => {
      if (receiveWorkerMemoryPort(worker, message)) {
        resolve();
      }
    });
    worker.once("error", reject);
  });
}
