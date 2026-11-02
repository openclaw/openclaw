import type { Worker } from "node:worker_threads";

export function observeWorkerConstructors(
  actual: typeof import("node:worker_threads"),
  workers: Worker[],
): typeof import("node:worker_threads") {
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        workers.push(this);
      }
    },
  };
}
