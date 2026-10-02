import { WorkerTaskPoolCore } from "./worker-task-pool-core.js";
import type {
  WorkerTaskInput,
  WorkerTaskOptions,
  WorkerTaskPoolOptions,
  WorkerTaskPoolOwnerOptions,
  OwnedWorkerTaskOptions,
} from "./worker-task-pool.types.js";

export { WorkerTaskError } from "./worker-task-pool-core.js";
export type { WorkerTaskResponse } from "./worker-task-pool.types.js";

/** Existing SDK surface; task custody remains an internal capability. */
export class WorkerTaskPool<Input, Output> {
  private readonly core: WorkerTaskPoolCore<Input, Output>;

  constructor(options: WorkerTaskPoolOptions<Output>) {
    this.core = new WorkerTaskPoolCore<Input, Output>(options, {
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

/** Internal resource owners can retain task custody or use settled ordinary reads. */
export function createOwnedWorkerTaskPool<Input, Output>(
  options: WorkerTaskPoolOptions<Output>,
  ownerOptions?: WorkerTaskPoolOwnerOptions,
) {
  const core = new WorkerTaskPoolCore<Input, Output>(options, undefined, ownerOptions);
  return {
    run: (input: WorkerTaskInput<Input>, taskOptions: WorkerTaskOptions<Input>) =>
      core.run(input, taskOptions),
    rotate: () => core.rotate(),
    runTask: (input: WorkerTaskInput<Input>, taskOptions: OwnedWorkerTaskOptions<Input>) =>
      core.runTask(input, taskOptions),
    startTask: (input: WorkerTaskInput<Input>, taskOptions: OwnedWorkerTaskOptions<Input>) =>
      core.startTask(input, taskOptions),
    closeResources: (key?: string) => core.startCloseResources(key).result,
    startCloseResources: (key?: string) => core.startCloseResources(key),
    startRotate: () => core.startRotate(),
    getSnapshot: () => core.getSnapshot(),
    close: (error?: Error) => core.close(error),
  };
}
