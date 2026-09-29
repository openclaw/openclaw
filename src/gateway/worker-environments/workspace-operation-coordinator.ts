import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";

export type WorkerWorkspaceOperationCoordinator = {
  run<T>(environmentId: string, operation: () => Promise<T>): Promise<T>;
};

/** Serializes local workspace mutation and forced teardown per environment. */
export function createWorkerWorkspaceOperationCoordinator(): WorkerWorkspaceOperationCoordinator {
  const queue = new KeyedAsyncQueue();
  return {
    run: (environmentId, operation) => queue.enqueue(environmentId, operation),
  };
}
