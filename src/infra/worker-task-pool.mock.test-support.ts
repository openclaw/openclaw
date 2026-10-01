import { createRetainedOperation } from "./retained-operation.js";
import type { createOwnedWorkerTaskPool } from "./worker-task-pool.js";

type Pool<Input, Output> = ReturnType<typeof createOwnedWorkerTaskPool<Input, Output>>;

function unexpectedTask(): never {
  throw new Error("Worker pool fixture requires an explicit task implementation");
}

function closedResources() {
  const closed = createRetainedOperation<void>(() => {});
  closed.resolve(undefined);
  return closed.operation;
}

/** No native resources are allocated; both resource-retirement paths remain available. */
export function createOwnedWorkerTaskPoolMock<Input, Output>(
  overrides: Partial<Pool<Input, Output>>,
): Pool<Input, Output> {
  return {
    run: unexpectedTask,
    runTask: unexpectedTask,
    startTask: unexpectedTask,
    getSnapshot: unexpectedTask,
    rotate: async () => {},
    startRotate: closedResources,
    closeResources: async () => {},
    startCloseResources: closedResources,
    close: async () => {},
    ...overrides,
  };
}
