import type { WorkerTaskPoolOwnerOptions as RuntimeOwnerOptions } from "@openclaw/worker-runtime";
import type { RetainedNativeWorkerSource } from "./worker-native-lifecycle.js";
import type { NativeWorkerResourceDescriptor } from "./worker-native-lifecycle.types.js";

export type {
  WorkerTaskInput,
  WorkerTaskOptions,
  WorkerTaskPoolOptions,
  WorkerTaskResponse,
  OwnedWorkerTaskOptions,
  RetainedWorkerTask,
} from "@openclaw/worker-runtime";

export type WorkerTaskPoolOwnerOptions = RuntimeOwnerOptions & {
  nativeSource?: RetainedNativeWorkerSource;
  nativeResource?: NativeWorkerResourceDescriptor;
};
