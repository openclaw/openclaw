import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { availableParallelism } from "node:os";
import type { Worker } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import { createCpuTrackedWorker, receiveWorkerMemoryPort } from "./worker-cpu.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
  getWorkerComputeCapacity,
} from "./worker-task-capacity.js";
import {
  createWorkerNativeSectionState,
  releaseWorkerNativeSectionsOnExit,
} from "./worker-task-native-sections.js";
import {
  createWorkerTaskCompletion,
  joinWorkerTaskPreparationCleanups,
  type WorkerTaskCompletion,
} from "./worker-task-pool-completion.js";
import {
  closeOwnedWorkerTask,
  joinOwnedWorkerTask,
  joinOwnedWorkerTasks,
  type OwnedWorkerTaskSettlement,
} from "./worker-task-pool-owned.js";
import { closeWorkerPoolResources } from "./worker-task-pool-resources.js";
import {
  createWorkerTaskPoolRetirement,
  type WorkerTaskPoolRetirement,
} from "./worker-task-pool-retirement.js";
import type {
  OwnedWorkerTask,
  WorkerTaskPoolDispatch,
  Slot,
  Task,
  WorkerTaskInput,
  WorkerTaskOptions,
  WorkerTaskPoolOptions,
} from "./worker-task-pool.types.js";

// Reusable workers must not retain the first submitting caller's async scope.
const runInWorkerPoolContext = AsyncLocalStorage.snapshot();

type WorkerReply<Output> = { status: "ok"; value: Output } | { status: "failed"; error: string };
export class WorkerTaskError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "timeout" | "failed" | "overloaded",
  ) {
    super(message);
    this.name = "WorkerTaskError";
  }
}

/** Bounded execution workers; each worker accepts one task at a time. */
class WorkerTaskPoolCore<Input, Output> {
  private readonly slots = new Set<Slot<Input, Output>>();
  private readonly ownedTasks = new Set<Task<Input, Output>>();
  private readonly resourceClosures = new WeakMap<Worker, { pending: number }>();
  private readonly ownedSettlement: OwnedWorkerTaskSettlement<Input, Output> = {
    cancel: (task) => this.cancel(task, new WorkerTaskError("worker task closed", "unavailable")),
    detach: (task) => {
      if (task.slot?.task === task) {
        task.slot.task = undefined;
        this.activeTasks--;
      }
    },
    retire: (slot) => this.retirement.retire(slot),
    release: (task, slot) => {
      if (!this.ownedTasks.delete(task)) {
        return;
      }
      this.releaseAdmission(task);
      task.runInContext = runInWorkerPoolContext;
      this.dispatch();
      if (slot && !task.owner?.retire && !slot.task && !slot.retiring) {
        this.idle(slot);
      }
    },
  };
  private readonly completion: WorkerTaskCompletion<Input, Output> = {
    preparationCleanups: new Map(),
    releaseAdmission: (task) => this.releaseAdmission(task),
    releaseCompute: (permit) => this.computeCapacity!.release(permit),
    diagnostics: () => ({
      worker: this.options.workerUrl.pathname.split("/").at(-1),
      ...(this.publicDispatch?.getSnapshot() ?? this.getSnapshot()),
      pendingBytes: this.pendingBytes,
    }),
  };
  private readonly retirement: WorkerTaskPoolRetirement<Input, Output>;
  private readonly queue: Task<Input, Output>[] = [];
  private readonly maxWorkers: number;
  private readonly maxPendingTasks: number;
  private readonly maxPendingBytes: number;
  private pendingTasks = 0;
  private pendingBytes = 0;
  private workers = 0;
  private workersCreated = 0;
  private activeTasks = 0;
  private readonly computeCapacity: ReturnType<typeof getWorkerComputeCapacity> | undefined;
  private readonly resumeCompute = () => this.dispatch();
  private closedError?: Error;
  private rotation?: Promise<void>;
  private rotationFailed = false;
  private nextTaskId = 0;
  // Idle retirement is armed from worker messages, outside any caller's turn.
  // Bind the clock at construction so a process-wide pool cannot land that timer
  // on a fake or stubbed setTimeout an unrelated test installed later; on the
  // wrong clock the worker never retires and that test's timer count is off.
  private readonly setTimeoutFn = setTimeout;
  private readonly clearTimeoutFn = clearTimeout;
  private readonly retireIdleOnPressure = () => this.retirement.retireIdle(this.resourceClosures);

  constructor(
    private readonly options: WorkerTaskPoolOptions<Output>,
    private readonly publicDispatch?: WorkerTaskPoolDispatch,
  ) {
    this.maxWorkers = options.maxWorkers ?? availableParallelism();
    this.maxPendingTasks = options.maxPendingTasks ?? DEFAULT_WORKER_PENDING_TASKS;
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_WORKER_PENDING_BYTES;
    for (const [name, value] of Object.entries({
      maxWorkers: this.maxWorkers,
      maxPendingTasks: this.maxPendingTasks,
      maxPendingBytes: this.maxPendingBytes,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    this.computeCapacity = options.sharedCompute ? getWorkerComputeCapacity() : undefined;
    this.retirement = createWorkerTaskPoolRetirement({
      slots: this.slots,
      options,
      clearIdleTimer: (timer) => this.clearTimeoutFn(timer),
      runInContext: runInWorkerPoolContext,
      dispatch: () => this.dispatch(),
    });
  }

  run(input: WorkerTaskInput<Input>, options: WorkerTaskOptions<Input>): Promise<Output> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    const inputBytes = options.inputBytes ?? 0;
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) {
      return Promise.reject(new RangeError("inputBytes must be a nonnegative safe integer"));
    }
    return this.enqueue(input, options, false, inputBytes).promise;
  }

  runTask(
    input: WorkerTaskInput<Input>,
    options: WorkerTaskOptions<Input>,
  ): OwnedWorkerTask<Output> {
    const task = this.enqueue(input, options, true);
    return {
      result: task.promise,
      close: (closeOptions) =>
        joinOwnedWorkerTask(task, this.ownedSettlement, closeOptions?.retire === true),
    };
  }

  private enqueue(
    input: WorkerTaskInput<Input>,
    options: WorkerTaskOptions<Input>,
    owned = false,
    inputBytes = options.inputBytes ?? 0,
  ): Task<Input, Output> {
    // A Promise executor would let the task's timer/abort closures retain input too.
    const task: Task<Input, Output> = {
      ...createDeferredCore<Output>(),
      id: ++this.nextTaskId,
      runInContext: AsyncLocalStorage.snapshot(),
      controller: new AbortController(),
      inputConsumed: false,
      executionNotified: false,
      exchangeSequence: 0,
      input,
      options: { ...options },
      abort: () => this.cancel(task, toErrorObject(options.signal?.reason, "worker task aborted")),
      done: false,
      admitted: false,
      ...(owned ? { owner: { closed: false, retire: false } } : {}),
      inputBytes,
      enqueuedAt: performance.now(),
      transferMs: 0,
    };
    if (owned) {
      this.ownedTasks.add(task);
    }
    if (this.closedError || !Number.isSafeInteger(inputBytes) || inputBytes < 0) {
      this.finish(
        task,
        this.closedError ?? new RangeError("inputBytes must be a nonnegative safe integer"),
      );
      return task;
    }
    if (
      this.pendingTasks >= this.maxPendingTasks ||
      this.pendingBytes + inputBytes > this.maxPendingBytes ||
      (this.computeCapacity && !this.computeCapacity.admit(inputBytes))
    ) {
      this.finish(task, new WorkerTaskError("worker task capacity reached", "overloaded"));
      return task;
    }
    task.admitted = true;
    this.pendingTasks++;
    this.pendingBytes += inputBytes;
    if (options.timeoutMs !== undefined) {
      this.armTimeout(task, options.timeoutMs);
    }
    options.signal?.addEventListener("abort", task.abort, { once: true });
    this.queue.push(task);
    if (options.signal?.aborted) {
      task.abort();
    } else {
      this.dispatch();
    }
    return task;
  }

  get isClosed(): boolean {
    return this.closedError !== undefined;
  }

  getSnapshot() {
    return {
      maxWorkers: this.maxWorkers,
      workers: this.workers,
      workersCreated: this.workersCreated,
      activeTasks: this.activeTasks,
      pendingTasks: this.pendingTasks,
    };
  }

  retryFailedRetirements(): Promise<void> {
    return this.retirement.retryFailedRetirements();
  }

  /** Close a retained native resource without cancelling other paths' tasks. */
  async closeResources(key?: string): Promise<void> {
    await closeWorkerPoolResources(this.slots, this.resourceClosures, key);
  }

  /** Pause dispatch, settle current work and join native exit before restarting the queue. */
  rotate(): Promise<void> {
    if (this.rotation) {
      return this.rotation;
    }
    const completion = createDeferredCore();
    this.rotation = completion.promise;
    this.rotationFailed = false;
    this.computeCapacity?.remove(this.resumeCompute);
    const slots = [...this.slots];
    const tasks = slots.flatMap((slot) => (slot.task ? [slot.task] : []));
    void Promise.allSettled(tasks.map((task) => task.promise))
      .then(() => Promise.all(slots.map((slot) => this.retirement.retire(slot))))
      .then(() => this.retirement.joinArtifacts())
      .then(
        () => {
          this.rotation = undefined;
          completion.resolve();
          this.dispatch();
        },
        (error: unknown) => {
          this.rotation = undefined;
          this.rotationFailed = true;
          completion.reject(error);
        },
      );
    return completion.promise;
  }

  close(
    error: Error = new WorkerTaskError("worker task pool closed", "unavailable"),
  ): Promise<void> {
    this.closedError ??= error;
    channel("openclaw.memory.critical").unsubscribe(this.retireIdleOnPressure);
    this.computeCapacity?.remove(this.resumeCompute);
    for (const task of this.queue.splice(0)) {
      this.finish(task, this.closedError);
    }
    for (const slot of this.slots) {
      if (slot.task && !slot.task.owner) {
        this.finish(slot.task, this.closedError, undefined, true);
      }
    }
    const tasks = [...this.ownedTasks];
    const ownedSlots = new Set(
      tasks.flatMap((task) => (task.slot?.task === task ? [task.slot] : [])),
    );
    const owned = tasks.map((task) => joinOwnedWorkerTask(task, this.ownedSettlement, true));
    // A failed owned stop must be observed before that task permits its next retry.
    const unowned = [...this.slots].filter((slot) => !ownedSlots.has(slot));
    const closures = [...owned, ...unowned.map((slot) => this.retirement.retire(slot))];
    return (tasks.length ? joinOwnedWorkerTasks(closures) : Promise.all(closures)).then(() =>
      joinWorkerTaskPreparationCleanups(this.completion, this.retirement.joinArtifacts()),
    );
  }

  private dispatch(): void {
    if (!this.slots.size) {
      channel("openclaw.memory.critical").unsubscribe(this.retireIdleOnPressure);
    }
    if (!this.queue.length || this.closedError || this.rotation || this.rotationFailed) {
      this.computeCapacity?.remove(this.resumeCompute);
    }
    while (!this.closedError && !this.rotation && !this.rotationFailed && this.queue.length) {
      let slot = [...this.slots].find(
        (entry) => !entry.task && !entry.retiring && !entry.retirementFailed,
      );
      if (!slot) {
        if (this.slots.size >= this.maxWorkers) {
          // A host-waiting task can checkpoint rather than monopolize a worker.
          // Signal one owner per queued contender, in slot admission order.
          let contenders = this.queue.length;
          for (const occupied of this.slots) {
            if (
              occupied.task?.exchange &&
              !occupied.task.exchange.sent &&
              !occupied.task.exchange.pressure.signal.aborted &&
              contenders-- > 0
            ) {
              occupied.task.exchange.pressure.abort();
            }
          }
          return;
        }
      }
      const nextTask = this.queue[0]!;
      if (this.computeCapacity) {
        const permit = this.computeCapacity.acquire(this.resumeCompute, () => {
          if (nextTask.exchange && !nextTask.exchange.sent) {
            nextTask.runInContext(() => nextTask.exchange?.pressure.abort());
            return true;
          }
          return false;
        });
        if (!permit) {
          return;
        }
        nextTask.computePermit = permit;
      }
      if (!slot) {
        slot = { nativeSections: createWorkerNativeSectionState() };
        this.slots.add(slot);
      }
      this.clearTimeoutFn(slot.idleTimer);
      const task = this.queue.shift()!;
      slot.task = task;
      this.activeTasks++;
      task.slot = slot;
      task.startedAt = performance.now();
      slot.worker?.ref();
      void task.runInContext(() => this.start(slot, task));
    }
  }

  // Worker listeners outlive tasks; their creation scope must not retain an async task frame.
  private createWorker(slot: Slot<Input, Output>): Worker {
    // A zero idle timeout delegates retirement (and retained custody) to the caller.
    if ((this.options.idleTimeoutMs ?? 60_000) > 0) {
      const pressure = channel("openclaw.memory.critical");
      pressure.unsubscribe(this.retireIdleOnPressure);
      pressure.subscribe(this.retireIdleOnPressure);
    }
    const worker = runInWorkerPoolContext(() => {
      const prepared = this.options.prepareWorker?.();
      slot.releaseResources = prepared?.releaseResources;
      const temporaryDirectory = prepared?.temporaryDirectory;
      if (temporaryDirectory) {
        const releaseResources = slot.releaseResources;
        slot.releaseResources = async () => {
          try {
            const { removeTemporaryArtifacts } = await import("./temp-artifact-cleanup.js");
            await removeTemporaryArtifacts(temporaryDirectory, "Worker task");
          } finally {
            await releaseResources?.();
          }
        };
      }
      const workerUrl = this.options.workerUrl;
      const workerOptions = {
        // Preserve native require(ESM) and its transitive import-only exports.
        execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
        ...this.options.workerOptions,
        ...prepared?.options,
      };
      // Preparation and option getters can synchronously close the task.
      if (slot.retiring) {
        throw new WorkerTaskError("worker creation closed during preparation", "unavailable");
      }
      return createCpuTrackedWorker(workerUrl, workerOptions);
    });
    this.workers++;
    this.workersCreated++;
    slot.worker = worker;
    worker.on("message", (message: unknown) => {
      // Native message events inherit the Worker's detached creation context.
      if (receiveWorkerMemoryPort(worker, message)) {
        return;
      }
      const task = slot.task;
      if (task) {
        task.runInContext(() => this.receive(slot, message));
      } else {
        this.receive(slot, message);
      }
    });
    worker.on("error", (error) =>
      this.fail(slot, new WorkerTaskError(String(error), "unavailable")),
    );
    worker.on("messageerror", (error) =>
      this.fail(slot, new WorkerTaskError(String(error), "unavailable")),
    );
    worker.once("exit", (code) => {
      releaseWorkerNativeSectionsOnExit(slot.nativeSections);
      this.workers--;
      this.fail(slot, new WorkerTaskError(`worker exited with code ${code}`, "unavailable"));
    });
    return worker;
  }

  private async start(slot: Slot<Input, Output>, task: Task<Input, Output>): Promise<void> {
    // Execution owns the input now; retaining it on task duplicates the worker's clone.
    const taskInput = task.input!;
    delete task.input;
    let input: Input;
    task.preparation = createDeferredCore();
    try {
      try {
        input =
          typeof taskInput === "function"
            ? await (taskInput as () => Input | Promise<Input>)() // SAFETY: Callable inputs are factories.
            : taskInput;
      } finally {
        task.preparation.resolve();
        task.preparation = undefined;
      }
    } catch (error) {
      // No input reached the worker; a rejected owner must not retire its healthy siblings.
      this.finish(task, toErrorObject(error, "worker task preparation failed"));
      return;
    }
    // A cancelled preparation may finish later, but it must never create or feed a worker.
    if (task.done) {
      return;
    }
    task.preparedAt = performance.now();
    try {
      const worker = slot.worker ?? this.createWorker(slot);
      const transferList = task.options.transferList?.(input);
      if (!task.done) {
        const transferStartedAt = performance.now();
        worker.postMessage(
          {
            input,
            taskId: task.id,
            interactive: Boolean(task.options.onRequest),
            nativeSections: slot.nativeSections.buffer,
            sampleMemory: true,
          },
          transferList,
        );
        task.transferMs += performance.now() - transferStartedAt;
      }
    } catch (error) {
      this.fail(slot, new WorkerTaskError(String(error), "unavailable"));
    }
  }

  private receive(slot: Slot<Input, Output>, message: unknown): void {
    if (slot.retiring) {
      return;
    }
    const task = slot.task;
    if (
      task &&
      isRecord(message) &&
      (message.status === "request" || message.status === "consumed")
    ) {
      try {
        this.receiveExchange(slot, task, message);
      } catch (error) {
        this.fail(slot, toErrorObject(error, "worker consumption callback failed"));
      }
      return;
    }
    if (
      !task ||
      !isRecord(message) ||
      ((task.options.onRequest || message.taskId !== undefined) && message.taskId !== task.id) ||
      (message.status !== "ok" && message.status !== "failed")
    ) {
      this.fail(slot, new WorkerTaskError("invalid worker task response", "unavailable"));
      return;
    }
    // SAFETY: The private worker entry owns Output; the transport discriminant is checked above.
    const reply = message as WorkerReply<Output>;
    if (reply.status === "failed") {
      this.finish(
        task,
        new WorkerTaskError(reply.error, "failed"),
        undefined,
        Boolean(task.exchange) || (Boolean(task.options.onInputConsumed) && !task.inputConsumed),
      );
      return;
    }
    try {
      // The owner must accept its lifecycle-bound result before a successor can execute.
      this.options.validateResult?.(reply.value);
    } catch (error) {
      this.fail(slot, toErrorObject(error, "worker result validation failed"));
      return;
    }
    if (task.exchange || (task.options.onInputConsumed && !task.inputConsumed)) {
      // A failed handler may not reach its consumption receipt. Termination,
      // rather than a result message, proves it no longer owns those inputs.
      this.finish(task, undefined, reply.value, true);
      return;
    }
    this.finish(task, undefined, reply.value);
  }

  private armTimeout(task: Task<Input, Output>, timeoutMs: number): void {
    clearTimeout(task.timer);
    task.timer = setTimeout(
      () => this.cancel(task, new WorkerTaskError("worker task timed out", "timeout")),
      resolveTimerTimeoutMs(timeoutMs, 60_000),
    );
  }

  private receiveExchange(
    slot: Slot<Input, Output>,
    task: Task<Input, Output>,
    message: Record<string, unknown>,
  ): void {
    if (message.taskId !== task.id) {
      this.fail(slot, new WorkerTaskError("stale worker exchange", "unavailable"));
      return;
    }
    if (message.status === "consumed") {
      if (message.id === 0 && !task.inputConsumed) {
        task.inputConsumed = true;
        const release = task.options.onInputConsumed;
        task.options.onInputConsumed = undefined;
        release?.();
      } else if (task.exchange?.sent && message.id === task.exchange.id) {
        const release = task.exchange.onConsumed;
        task.exchange = undefined;
        release?.();
      } else {
        this.fail(slot, new WorkerTaskError("invalid worker consumption receipt", "unavailable"));
      }
      return;
    }
    if (
      !task.options.onRequest ||
      task.exchange ||
      !Number.isSafeInteger(message.id) ||
      message.id !== task.exchangeSequence + 1
    ) {
      this.fail(slot, new WorkerTaskError("invalid worker exchange", "unavailable"));
      return;
    }
    // The owner, not a second pool clock, budgets host waits and pauses approvals.
    clearTimeout(task.timer);
    const exchange: Task<Input, Output>["exchange"] = {
      id: ++task.exchangeSequence,
      pressure: new AbortController(),
      sent: false,
      onConsumed: undefined,
    };
    task.exchange = exchange;
    this.dispatch();
    this.computeCapacity?.requestCheckpoints();
    void Promise.resolve()
      .then(() => {
        if (task.done || slot.task !== task) {
          throw new WorkerTaskError("worker task closed before host dispatch", "unavailable");
        }
        return task.options.onRequest!(message.value, {
          signal: task.controller.signal,
          yieldSignal: exchange.pressure.signal,
        });
      })
      .then((response) => {
        if (task.done || slot.task !== task || slot.retiring) {
          // A slow host handler may settle after cancellation. Never feed a successor.
          const release = () => {
            try {
              task.runInContext(() => response.onConsumed?.());
            } catch {
              // The closed task retains its original failure, as in the exchange catch below.
            }
          };
          if (this.slots.has(slot)) {
            (slot.completions ??= []).push(release);
          } else {
            release();
          }
          return;
        }
        exchange.onConsumed = response.onConsumed;
        exchange.sent = true;
        this.armTimeout(task, response.timeoutMs);
        try {
          slot.worker!.postMessage(
            {
              taskId: task.id,
              responseId: exchange.id,
              input: response.input,
            },
            response.transferList,
          );
        } catch (error) {
          this.fail(slot, toErrorObject(error, "worker response delivery failed"));
        }
      })
      .catch((error: unknown) => {
        if (!task.done && slot.task === task) {
          this.fail(slot, toErrorObject(error, "worker host exchange failed"));
        }
      });
  }

  private cancel(task: Task<Input, Output>, error: Error): void {
    if (task.done) {
      return;
    }
    if (task.slot) {
      if (task.owner) {
        this.finish(task, error, undefined, true);
      } else {
        this.fail(task.slot, error);
      }
    } else {
      // Only queued tasks lack a slot; dispatch and close remove their entries themselves.
      this.queue.splice(this.queue.indexOf(task), 1);
      this.finish(task, error);
    }
  }

  private fail(slot: Slot<Input, Output>, error: Error): void {
    if (slot.retiring) {
      return;
    }
    if (slot.task?.owner) {
      if (slot.task.done) {
        // Late events cannot retry a failed stop before the owner explicitly requests it.
        if (!slot.task.owner.retire) {
          void closeOwnedWorkerTask(slot.task, this.ownedSettlement, true).catch(() => undefined);
        }
      } else {
        this.finish(slot.task, error, undefined, true);
      }
    } else if (this.options.restartOnError === false) {
      void (this.publicDispatch?.close(error) ?? this.close(error)).catch(() => undefined);
    } else if (slot.task) {
      this.finish(slot.task, error, undefined, true);
    } else {
      void this.retirement.retire(slot).catch(() => undefined);
    }
  }

  private finish(task: Task<Input, Output>, error?: Error, value?: Output, retire = false): void {
    if (task.done) {
      return;
    }
    task.done = true;
    task.runInContext(() => task.controller.abort());
    clearTimeout(task.timer);
    task.options.signal?.removeEventListener("abort", task.abort);
    const complete = createWorkerTaskCompletion(task, this.completion, error, value);
    if (task.owner) {
      task.owner.complete = complete;
      task.owner.retire ||= retire || Boolean(error && task.slot);
      if (error) {
        task.reject(error);
      } else {
        // SAFETY: A validated successful reply supplies Output; custody remains held separately.
        task.resolve(value as Output);
      }
      if (error || retire) {
        // Keep the first failed stop until an explicit close observes it and permits retry.
        void closeOwnedWorkerTask(task, this.ownedSettlement).catch(() => undefined);
      }
      return;
    }
    const slot = task.slot;
    if (slot) {
      slot.task = undefined;
      this.activeTasks--;
      if (retire) {
        // Keep input and capacity custody until execution stops, even if rejection is early.
        (slot.completions ??= []).push(complete);
        void this.retirement.retire(slot).catch((failure: unknown) => {
          task.reject(
            error
              ? new AggregateError(
                  [error, failure],
                  `Worker retirement failed: ${toErrorObject(failure, "worker retirement failed").message}; task failed: ${error.message}`,
                  { cause: failure },
                )
              : failure,
          );
        });
        return;
      }
    }
    complete();
    this.dispatch();
    if (slot && !slot.task && !slot.retiring) {
      this.idle(slot);
    }
  }

  private releaseAdmission(task: Task<Input, Output>): void {
    if (task.admitted) {
      task.admitted = false;
      this.pendingTasks--;
      this.pendingBytes -= task.inputBytes;
      this.computeCapacity?.finish(task.inputBytes);
    }
  }

  // Reply handling restores the caller's context; idle retirement must leave it behind.
  private idle(slot: Slot<Input, Output>): void {
    if (slot.worker && !this.resourceClosures.get(slot.worker)?.pending) {
      slot.worker.unref();
    }
    const idleMs = this.options.idleTimeoutMs ?? 60_000;
    if (idleMs > 0) {
      slot.idleTimer = runInWorkerPoolContext(() =>
        this.setTimeoutFn(() => void this.retirement.retire(slot).catch(() => undefined), idleMs),
      );
      slot.idleTimer.unref();
    }
  }
}

export function createWorkerTaskPoolCore<Input, Output>(
  options: WorkerTaskPoolOptions<Output>,
  publicDispatch?: WorkerTaskPoolDispatch,
) {
  return new WorkerTaskPoolCore<Input, Output>(options, publicDispatch);
}
