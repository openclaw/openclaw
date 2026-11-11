import { WorkerTaskPoolCore, type WorkerRetirementReason } from "@openclaw/worker-runtime";
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

type SqliteCloseCore = {
  startCloseResources(key?: string): { result: Promise<void> };
};

/** Class instances keep their core here so callers can close sqlite without a public method. */
const sqliteCloseCores = new WeakMap<object, SqliteCloseCore>();

/** Existing SDK surface; task custody remains an internal capability. */
export class WorkerTaskPool<Input, Output> {
  private readonly core: WorkerTaskPoolCore<Input, Output>;

  constructor(options: WorkerTaskPoolOptions<Output>) {
    this.core = new WorkerTaskPoolCore<Input, Output>(
      options,
      createWorkerTaskHost(undefined, options.workerClass),
      {
        close: (error) => this.close(error),
        getSnapshot: () => this.getSnapshot(),
      },
    );
    sqliteCloseCores.set(this, this.core);
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

  close(error?: Error, reason?: WorkerRetirementReason): Promise<void> {
    return this.core.close(error, reason);
  }
}

/**
 * Sqlite close for one pool. Owned pools already expose closeResources; class
 * instances use the module-private core map. Not a plugin SDK method.
 */
export function closeTaskPoolSqliteResources(
  pool: object,
  key?: string,
): Promise<void> | undefined {
  if ("closeResources" in pool && typeof pool.closeResources === "function") {
    return (pool.closeResources as (key?: string) => Promise<void>)(key);
  }
  return sqliteCloseCores.get(pool)?.startCloseResources(key).result;
}

/** Internal resource owners can retain task custody or use settled ordinary reads. */
export function createOwnedWorkerTaskPool<Input, Output>(
  options: WorkerTaskPoolOptions<Output>,
  ownerOptions?: WorkerTaskPoolOwnerOptions,
) {
  const core = new WorkerTaskPoolCore<Input, Output>(
    options,
    createWorkerTaskHost(ownerOptions, options.workerClass),
    undefined,
    ownerOptions,
  );
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
