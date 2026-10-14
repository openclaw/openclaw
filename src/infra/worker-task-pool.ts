import { WorkerTaskPoolCore } from "@openclaw/worker-runtime";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { retainNativeWorkerPoolForGeneration } from "./worker-native-lifecycle.js";
import { createWorkerTaskHost } from "./worker-task-host.js";
import type {
  WorkerTaskInput,
  WorkerTaskOptions,
  WorkerTaskPoolOptions,
  WorkerTaskPoolOwnerOptions,
  OwnedWorkerTaskOptions,
} from "./worker-task-pool.types.js";

export { WorkerTaskError } from "@openclaw/worker-runtime";
export type { WorkerTaskResponse } from "./worker-task-pool.types.js";

function createWorkerTaskPoolCore<Input, Output>(
  options: WorkerTaskPoolOptions<Output>,
  ownerOptions?: WorkerTaskPoolOwnerOptions,
  dispatch?: ConstructorParameters<typeof WorkerTaskPoolCore<Input, Output>>[2],
) {
  // Worker creation detaches the caller's scope; retain its prepared code and
  // pool cleanup before a runtime swap can retire that source.
  const source = captureRuntimeWorkerSource(options.workerUrl);
  const host = createWorkerTaskHost(source, ownerOptions, options.workerClass);
  const core = new WorkerTaskPoolCore<Input, Output>(options, host, dispatch, ownerOptions);
  // A native owner in this generation drains domains before pool retirement.
  // Other native lifetimes stay independent; this code generation still joins its pool.
  const generation = source.runtimeGeneration;
  if (generation && !retainNativeWorkerPoolForGeneration(host.nativeSource, generation, core)) {
    generation.retain(core, () => core.close());
  }
  return core;
}

/** Existing SDK surface; task custody remains an internal capability. */
export class WorkerTaskPool<Input, Output> {
  private readonly core: WorkerTaskPoolCore<Input, Output>;

  constructor(options: WorkerTaskPoolOptions<Output>) {
    this.core = createWorkerTaskPoolCore<Input, Output>(options, undefined, {
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
  const core = createWorkerTaskPoolCore<Input, Output>(options, ownerOptions);
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
