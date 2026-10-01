import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import { createCpuTrackedWorker, receiveWorkerMemoryPort } from "./worker-cpu.js";
import {
  createRetainedNativeWorker,
  type RetainedNativeWorkerSource,
} from "./worker-native-lifecycle.js";
import type {
  NativeWorkerResourceDescriptor,
  WorkerLifecycle,
} from "./worker-native-lifecycle.types.js";
import { releaseWorkerNativeSectionsOnExit } from "./worker-task-native-sections.js";
import type { Slot, WorkerTaskPoolOptions } from "./worker-task-pool.types.js";

export const prepareWorkerTaskResources = createLazyRuntimeModule(
  () => import("./temp-artifact-cleanup.js"),
);

/** Physical construction and listeners share the pool's detached creation scope. */
export function createWorkerTaskPoolWorker<Input, Output>(params: {
  slot: Slot<Input, Output>;
  options: Pick<WorkerTaskPoolOptions<Output>, "workerUrl" | "workerOptions" | "prepareWorker">;
  retainedTransport?: true;
  nativeSource?: RetainedNativeWorkerSource;
  nativeResource?: NativeWorkerResourceDescriptor;
  runInContext: <T>(operation: () => T) => T;
  unavailableError: (message: string) => Error;
  onStarted: (worker: WorkerLifecycle) => void;
  onMessage: (message: unknown) => void;
  onFailure: (error: Error) => void;
  onExit: (code: number | undefined, counted: boolean) => void;
}): WorkerLifecycle {
  const { slot, options } = params;
  const worker: WorkerLifecycle = params.runInContext(() => {
    const prepared = options.prepareWorker?.();
    slot.releaseResources = prepared?.releaseResources;
    const temporaryDirectory = prepared?.temporaryDirectory;
    if (temporaryDirectory) {
      const cleanup = prepareWorkerTaskResources();
      const releaseResources = slot.releaseResources;
      slot.releaseResources = async () => {
        try {
          const { removeTemporaryArtifacts } = await cleanup;
          await removeTemporaryArtifacts(temporaryDirectory, "Worker task");
        } finally {
          await releaseResources?.();
        }
      };
    }
    const workerUrl = options.workerUrl;
    const workerOptions = {
      // Preserve native require(ESM) and its transitive import-only exports.
      execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
      ...options.workerOptions,
      ...prepared?.options,
    };
    // Preparation and option getters can synchronously close the task.
    if (slot.retiring) {
      throw params.unavailableError("worker creation closed during preparation");
    }
    if (params.retainedTransport) {
      const native = createRetainedNativeWorker(
        workerUrl,
        workerOptions,
        params.nativeSource,
        params.nativeResource,
      );
      slot.native = native;
      return native;
    }
    return createCpuTrackedWorker(workerUrl, workerOptions);
  });
  let counted = false;
  const started = () => {
    if (counted) {
      return;
    }
    counted = true;
    params.onStarted(worker);
  };
  if (slot.native) {
    slot.native.on("started", started);
    slot.native.on("execution-exit", (code) => {
      releaseWorkerNativeSectionsOnExit(slot.nativeSections);
      if (!slot.retiring) {
        params.onFailure(params.unavailableError(`worker exited with code ${code}`));
      }
    });
  } else {
    started();
  }
  slot.worker = worker;
  worker.on("message", (message: unknown) => {
    // Native message events inherit the Worker's detached creation context.
    if (receiveWorkerMemoryPort(worker, message)) {
      return;
    }
    const task = slot.task;
    if (task) {
      task.runInContext(() => params.onMessage(message));
    } else {
      params.onMessage(message);
    }
  });
  worker.on("error", (error) => params.onFailure(params.unavailableError(String(error))));
  worker.on("messageerror", (error) => params.onFailure(params.unavailableError(String(error))));
  worker.once("exit", (code) => {
    releaseWorkerNativeSectionsOnExit(slot.nativeSections);
    const wasCounted = counted;
    counted = false;
    params.onExit(code, wasCounted);
  });
  return worker;
}
