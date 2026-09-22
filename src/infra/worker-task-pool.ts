import { createWorkerTaskPoolCore } from "./worker-task-pool-core.js";
import type {
  WorkerTaskInput,
  WorkerTaskOptions,
  WorkerTaskPoolOptions,
} from "./worker-task-pool.types.js";

export { WorkerTaskError } from "./worker-task-pool-core.js";
export type { WorkerTaskResponse } from "./worker-task-pool.types.js";

/** Existing SDK surface; task custody remains an internal capability. */
export class WorkerTaskPool<Input, Output> {
  private readonly core: ReturnType<typeof createWorkerTaskPoolCore<Input, Output>>;

  constructor(options: WorkerTaskPoolOptions<Output>) {
    this.core = createWorkerTaskPoolCore<Input, Output>(options, {
      close: (error) => this.close(error),
      getSnapshot: () => this.getSnapshot(),
    });
  }

  run(input: WorkerTaskInput<Input>, options: WorkerTaskOptions<Input>): Promise<Output> {
    return this.core.run(input, options);
  }

  get isClosed(): boolean {
    return this.core.isClosed;
  }

  getSnapshot() {
    return this.core.getSnapshot();
  }

  retryFailedRetirements(): Promise<void> {
    return this.core.retryFailedRetirements();
  }

  rotate(): Promise<void> {
    return this.core.rotate();
  }

  close(error?: Error): Promise<void> {
    return this.core.close(error);
  }
}

/** Internal callers retain each result's slot through their native cleanup decision. */
export function createOwnedWorkerTaskPool<Input, Output>(options: WorkerTaskPoolOptions<Output>) {
  const core = createWorkerTaskPoolCore<Input, Output>(options);
  return {
    runTask: (input: WorkerTaskInput<Input>, taskOptions: WorkerTaskOptions<Input>) =>
      core.runTask(input, taskOptions),
    closeResources: (key?: string) => core.closeResources(key),
    getSnapshot: () => core.getSnapshot(),
    close: (error?: Error) => core.close(error),
  };
}
