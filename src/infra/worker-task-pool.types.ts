import type { AsyncLocalStorage } from "node:async_hooks";
import type { Worker, Transferable, WorkerOptions } from "node:worker_threads";
import type { Deferred } from "../shared/deferred.js";
import type { WorkerComputePermit } from "./worker-task-capacity.js";
import type { WorkerNativeSectionState } from "./worker-task-native-sections.js";

export type WorkerTaskPoolOptions<Output> = {
  workerUrl: URL;
  workerOptions?: Omit<WorkerOptions, "eval">;
  /** Shallow per-Worker overrides; resources stay owned until confirmed Worker exit. */
  prepareWorker?: () => {
    options: Omit<WorkerOptions, "eval">;
    temporaryDirectory?: string;
    /** Runs after temporary-directory cleanup; terminal close joins completion. */
    releaseResources?: () => Promise<void>;
  };
  maxWorkers?: number;
  /** Share CPU admission with other stateless compute pools in this isolate. */
  sharedCompute?: boolean;
  /** Include queued, preparing, and running tasks until execution has settled. */
  maxPendingTasks?: number;
  maxPendingBytes?: number;
  idleTimeoutMs?: number;
  restartOnError?: boolean;
  validateResult?: (value: Output) => void;
  /** Reports failed stops synchronously; returned rejections never delay retirement. */
  onRetirementFailure?: (error: unknown) => void | Promise<void>;
};

export type WorkerTaskResponse = {
  input: unknown;
  /** Move owned binary replies instead of copying large inventories back to the worker. */
  transferList?: readonly Transferable[];
  /** Remaining owner budget, plus its existing watchdog grace. */
  timeoutMs: number;
  /** Release input ownership only after worker consumption or confirmed termination. */
  onConsumed?: () => void;
};

type WorkerTaskRequestContext = {
  /** Task lifetime: closes on completion/checkpoint as well as cancellation. */
  signal: AbortSignal;
  /** Queue pressure requests a checkpoint; it does not cancel underlying host work. */
  yieldSignal: AbortSignal;
};

export type WorkerTaskInput<Input> = Input | (() => Input | Promise<Input>);

type WorkerTaskExecutionSettlement = {
  /** True only after this task's worker termination has been joined. */
  retired: boolean;
};

export type WorkerTaskOptions<Input> = {
  /** Known retained input bytes, including inputs captured by a factory. No serialization pass. */
  inputBytes?: number;
  /** When supplied, queueing and asynchronous preparation consume the execution deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
  transferList?: (input: Input) => readonly Transferable[];
  onRequest?: (value: unknown, context: WorkerTaskRequestContext) => Promise<WorkerTaskResponse>;
  onInputConsumed?: () => void;
  /** Native task receipt before its result; async input preparation and host effects are not joined. */
  onExecutionSettled?: (settlement: WorkerTaskExecutionSettlement) => void;
};

/** Internal custody: a result alone does not release its slot or notify execution settlement. */
export type OwnedWorkerTask<Output> = {
  result: Promise<Output>;
  /** Joins cleanup and its execution receipt; failure can also begin cleanup automatically. */
  close(options?: { retire?: true }): Promise<void>;
};

type TaskOwner = {
  closed: boolean;
  retire: boolean;
  closing?: Promise<void>;
  complete?: () => void;
};

type WorkerHostExchange = {
  id: number;
  pressure: AbortController;
  onConsumed?: () => void;
  sent: boolean;
};

export type Task<Input, Output> = Deferred<Output> & {
  id: number;
  runInContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
  controller: AbortController;
  exchange?: WorkerHostExchange;
  inputConsumed: boolean;
  executionNotified: boolean;
  exchangeSequence: number;
  input?: WorkerTaskInput<Input>;
  options: WorkerTaskOptions<Input>;
  timer?: NodeJS.Timeout;
  abort: () => void;
  done: boolean;
  slot?: Slot<Input, Output>;
  admitted: boolean;
  /** Present only while the input factory is pending. */
  preparation?: Deferred;
  owner?: TaskOwner;
  inputBytes: number;
  computePermit?: WorkerComputePermit;
  enqueuedAt: number;
  startedAt?: number;
  preparedAt?: number;
  transferMs: number;
};
export type Slot<Input, Output> = {
  nativeSections: WorkerNativeSectionState;
  worker?: Worker;
  /** Retryable receipt for this exact Worker, captured before it can exit. */
  settleNativeExit?: () => Promise<void>;
  releaseResources?: () => Promise<void>;
  task?: Task<Input, Output>;
  idleTimer?: NodeJS.Timeout;
  retiring?: Promise<void>;
  /** The retirement owner has joined this exact slot's native termination barrier. */
  retired?: true;
  retirementFailed?: boolean;
  completions?: Array<() => void>;
};

export type WorkerTaskPoolDispatch = {
  close(error: Error): Promise<void>;
  getSnapshot(): {
    maxWorkers: number;
    workers: number;
    workersCreated: number;
    activeTasks: number;
    pendingTasks: number;
  };
};
