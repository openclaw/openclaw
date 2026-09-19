import type { Slot, Task } from "./worker-task-pool.types.js";

export type OwnedWorkerTaskSettlement<Input, Output> = {
  cancel(task: Task<Input, Output>): void;
  detach(task: Task<Input, Output>): void;
  retire(slot: Slot<Input, Output>): Promise<void>;
  release(task: Task<Input, Output>, slot: Slot<Input, Output> | undefined): void;
};

export async function joinOwnedWorkerTasks(closures: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(closures);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Worker task cleanup failed");
  }
}

export function joinOwnedWorkerTask<Input, Output>(
  task: Task<Input, Output>,
  settlement: OwnedWorkerTaskSettlement<Input, Output>,
  retire = false,
): Promise<void> {
  const closing = closeOwnedWorkerTask(task, settlement, retire);
  return closing
    .catch((error: unknown) => {
      // Only an observed failed stop permits the next explicit close to retry it.
      if (task.owner?.closing === closing) {
        task.owner.closing = undefined;
      }
      throw error;
    })
    .finally(() => {
      if (task.owner?.closed) {
        const slot = task.slot;
        task.slot = undefined;
        settlement.release(task, slot);
      }
    });
}

export function closeOwnedWorkerTask<Input, Output>(
  task: Task<Input, Output>,
  settlement: OwnedWorkerTaskSettlement<Input, Output>,
  retire = false,
): Promise<void> {
  const owner = task.owner;
  if (!owner) {
    return Promise.resolve();
  }
  if (owner.closed) {
    return owner.closing ?? Promise.resolve();
  }
  owner.retire ||= retire;
  if (!task.done) {
    settlement.cancel(task);
  }
  return (owner.closing ??= Promise.resolve().then(async () => {
    await task.preparation?.promise;
    const slot = task.slot;
    if (slot && owner.retire) {
      await settlement.retire(slot);
    }
    settlement.detach(task);
    try {
      owner.complete?.();
    } finally {
      owner.closed = true;
      owner.complete = undefined;
      task.input = undefined;
      task.options = {};
      task.abort = () => {};
    }
  }));
}
