import type {
  WorkerTaskPoolOptions as RuntimePoolOptions,
  WorkerTaskPoolOwnerOptions as RuntimeOwnerOptions,
} from "@openclaw/worker-runtime";
import type { RetainedNativeWorkerSource } from "./worker-native-lifecycle.js";
import type { NativeWorkerResourceDescriptor } from "./worker-native-lifecycle.types.js";
import type { WorkerPoolClass } from "./worker-pool-sizing.js";

export type {
  WorkerTaskInput,
  WorkerTaskOptions,
  WorkerTaskResponse,
  OwnedWorkerTaskOptions,
  RetainedWorkerTask,
} from "@openclaw/worker-runtime";

export type WorkerTaskPoolOptions<Output> = RuntimePoolOptions<Output> &
  Pick<WorkerTaskPoolOwnerOptions, "databaseAccess"> & {
    /** Class sizing takes precedence; maxWorkers may retain an older host's SDK fallback. */
    workerClass?: WorkerPoolClass;
  };

export type WorkerTaskPoolOwnerOptions = RuntimeOwnerOptions & {
  /** Canonical databases stay read-only; writes to private snapshot files are allowed. */
  databaseAccess?: "read-only";
  nativeSource?: RetainedNativeWorkerSource;
  nativeResource?: NativeWorkerResourceDescriptor;
};
