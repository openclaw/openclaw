import type { AsyncLocalStorage } from "node:async_hooks";
import type { Worker, Transferable } from "node:worker_threads";
import type { Deferred } from "../shared/deferred.js";
import type { WorkerComputePermit } from "./worker-task-capacity.js";
import type { WorkerNativeSectionState } from "./worker-task-native-sections.js";

export type WorkerTaskResponse = {
  input: unknown;
  /** Move owned binary replies instead of copying large inventories back to the worker. */
  transferList?: readonly Transferable[];
  /** Remaining owner budget, plus its existing watchdog grace. */
  timeoutMs: number;
  /** Release input ownership only after worker consumption or confirmed termination. */
  onConsumed?: () => void;
};

export type WorkerTaskRequestContext = {
  /** Task lifetime: closes on completion/checkpoint as well as cancellation. */
  signal: AbortSignal;
  /** Queue pressure requests a checkpoint; it does not cancel underlying host work. */
  yieldSignal: AbortSignal;
};

export type WorkerTaskInput<Input> = Input | (() => Input | Promise<Input>);

export type WorkerTaskOptions<Input> = {
  /** Known retained input bytes, including inputs captured by a factory. No serialization pass. */
  inputBytes?: number;
  /** When supplied, queueing and asynchronous preparation consume the execution deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
  transferList?: (input: Input) => readonly Transferable[];
  onRequest?: (value: unknown, context: WorkerTaskRequestContext) => Promise<WorkerTaskResponse>;
  onInputConsumed?: () => void;
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
  exchangeSequence: number;
  input?: WorkerTaskInput<Input>;
  options: WorkerTaskOptions<Input>;
  timer?: NodeJS.Timeout;
  abort: () => void;
  done: boolean;
  slot?: Slot<Input, Output>;
  admitted: boolean;
  preparing: boolean;
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
  temporaryDirectory?: string;
  task?: Task<Input, Output>;
  idleTimer?: NodeJS.Timeout;
  retiring?: Promise<void>;
  retirementFailed?: boolean;
  completions?: Array<() => void>;
};
