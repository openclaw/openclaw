import { AsyncLocalStorage } from "node:async_hooks";
import { channel as createDiagnosticsChannel } from "node:diagnostics_channel";
import { availableParallelism } from "node:os";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../shared/deferred.js";
import { runBestEffortCleanup } from "./non-fatal-cleanup.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
  getWorkerComputeCapacity,
} from "./worker-task-capacity.js";
import {
  cancelWorkerNativeSections,
  createWorkerNativeSectionState,
  releaseWorkerNativeSectionsOnExit,
  waitForWorkerNativeSections,
} from "./worker-task-native-sections.js";
import type { Slot, Task, WorkerTaskInput, WorkerTaskOptions } from "./worker-task-pool.types.js";

export type { WorkerTaskRequestContext, WorkerTaskResponse } from "./worker-task-pool.types.js";
export type { WorkerTaskControl } from "./worker-task-native-sections.js";
export { serveWorkerTasks } from "./worker-task-server.js";
export type { WorkerTaskChannel } from "./worker-task-server.js";

// Reusable workers must not retain the first submitting caller's async scope.
const runInWorkerPoolContext = AsyncLocalStorage.snapshot();
const taskDiagnostics = createDiagnosticsChannel("openclaw.worker.task");

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
export class WorkerTaskPool<Input, Output> {
  private readonly slots = new Set<Slot<Input, Output>>();
  private readonly artifactCleanups = new Set<Promise<void>>();
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

  constructor(
    private readonly options: {
      workerUrl: URL;
      workerOptions?: Omit<WorkerOptions, "eval">;
      /** Shallow per-Worker overrides; returned scratch stays owned until Worker exit. */
      prepareWorker?: () => {
        options: Omit<WorkerOptions, "eval">;
        temporaryDirectory?: string;
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
    },
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
  }

  run(input: WorkerTaskInput<Input>, options: WorkerTaskOptions<Input>): Promise<Output> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    const inputBytes = options.inputBytes ?? 0;
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) {
      return Promise.reject(new RangeError("inputBytes must be a nonnegative safe integer"));
    }
    // A Promise executor would let the task's timer/abort closures retain input too.
    const task: Task<Input, Output> = {
      ...createDeferredCore<Output>(),
      id: ++this.nextTaskId,
      runInContext: AsyncLocalStorage.snapshot(),
      controller: new AbortController(),
      inputConsumed: false,
      exchangeSequence: 0,
      input,
      options: { ...options },
      abort: () => this.cancel(task, toErrorObject(options.signal?.reason, "worker task aborted")),
      done: false,
      admitted: false,
      preparing: false,
      inputBytes,
      enqueuedAt: performance.now(),
      transferMs: 0,
    };
    if (
      this.pendingTasks >= this.maxPendingTasks ||
      this.pendingBytes + inputBytes > this.maxPendingBytes ||
      (this.computeCapacity && !this.computeCapacity.admit(inputBytes))
    ) {
      this.finish(task, new WorkerTaskError("worker task capacity reached", "overloaded"));
      return task.promise;
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
    return task.promise;
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
      .then(() => Promise.all(slots.map((slot) => this.retire(slot))))
      .then(() => Promise.all(this.artifactCleanups))
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
    this.computeCapacity?.remove(this.resumeCompute);
    for (const task of this.queue.splice(0)) {
      this.finish(task, this.closedError);
    }
    for (const slot of this.slots) {
      if (slot.task) {
        this.finish(slot.task, this.closedError, undefined, true);
      }
    }
    return Promise.all([...this.slots].map((slot) => this.retire(slot)))
      .then(() => Promise.all(this.artifactCleanups))
      .then(() => undefined);
  }

  private dispatch(): void {
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
    const worker = runInWorkerPoolContext(() => {
      const prepared = this.options.prepareWorker?.();
      slot.temporaryDirectory = prepared?.temporaryDirectory;
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
      return new Worker(workerUrl, workerOptions);
    });
    this.workers++;
    this.workersCreated++;
    slot.worker = worker;
    worker.on("message", (message: unknown) => {
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
    task.preparing = true;
    try {
      input =
        typeof taskInput === "function"
          ? await (taskInput as () => Input | Promise<Input>)() // SAFETY: Callable inputs are factories.
          : taskInput;
    } catch (error) {
      // No input reached the worker; a rejected owner must not retire its healthy siblings.
      this.finish(task, toErrorObject(error, "worker task preparation failed"));
      return;
    } finally {
      task.preparing = false;
      if (task.done) {
        this.releaseAdmission(task);
      }
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
      .then(async (response) => {
        if (task.done || slot.task !== task || slot.retiring) {
          // A slow host handler may settle after cancellation. Never feed a successor.
          await slot.retiring;
          response.onConsumed?.();
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
      this.fail(task.slot, error);
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
    if (this.options.restartOnError === false) {
      void this.close(error);
    } else if (slot.task) {
      this.finish(slot.task, error, undefined, true);
    } else {
      void this.retire(slot);
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
    // SAFETY: Only a validated successful reply reaches finish without an error and supplies Output.
    const complete = () =>
      task.runInContext(() => {
        if (!task.preparing) {
          this.releaseAdmission(task);
        }
        let completionError = error;
        try {
          // Retiring completion runs only after terminate() resolves. Queued inputs
          // were never delivered; both paths release without claiming consumption.
          if (!task.inputConsumed) {
            task.inputConsumed = true;
            task.options.onInputConsumed?.();
          }
          const release = task.exchange?.onConsumed;
          task.exchange = undefined;
          release?.();
        } catch (releaseError) {
          completionError ??= toErrorObject(releaseError, "worker input release failed");
        }
        const permit = task.computePermit;
        task.computePermit = undefined;
        if (permit) {
          this.computeCapacity!.release(permit);
        }
        if (taskDiagnostics.hasSubscribers) {
          const now = performance.now();
          taskDiagnostics.publish({
            worker: this.options.workerUrl.pathname.split("/").at(-1),
            ...this.getSnapshot(),
            outcome: completionError ? "failed" : "ok",
            queueMs: (task.startedAt ?? now) - task.enqueuedAt,
            preparationMs:
              task.startedAt === undefined ? 0 : (task.preparedAt ?? now) - task.startedAt,
            runMs: task.preparedAt === undefined ? 0 : now - task.preparedAt,
            transferMs: task.transferMs,
            pendingBytes: this.pendingBytes,
          });
        }
        if (completionError) {
          task.reject(completionError);
        } else {
          // SAFETY: A successful validated worker reply supplies Output to finish.
          task.resolve(value as Output);
        }
      });
    const slot = task.slot;
    if (slot) {
      slot.task = undefined;
      this.activeTasks--;
      if (retire) {
        // Keep the slot reserved and the caller pending until its execution actually stops.
        (slot.completions ??= []).push(complete);
        void this.retire(slot).catch((failure: unknown) => {
          task.reject(failure);
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
    slot.worker?.unref();
    const idleMs = this.options.idleTimeoutMs ?? 60_000;
    if (idleMs > 0) {
      slot.idleTimer = runInWorkerPoolContext(() =>
        this.setTimeoutFn(() => void this.retire(slot), idleMs),
      );
      slot.idleTimer.unref();
    }
  }

  private retire(slot: Slot<Input, Output>): Promise<void> {
    this.clearTimeoutFn(slot.idleTimer);
    cancelWorkerNativeSections(slot.nativeSections);
    // Retain error listeners until exit: termination can race a worker startup error.
    // Constructor observers can retire this slot before its Worker is assigned.
    return (slot.retiring ??= Promise.resolve()
      .then(async () => {
        if (slot.worker) {
          // Node can abort if termination interrupts zlib between allocation and initialization.
          // Keep custody until the current bounded native operation settles, including on timeout.
          const settlement = waitForWorkerNativeSections(slot.nativeSections);
          if (settlement) {
            await settlement;
          }
          await slot.worker.terminate();
        }
      })
      .then(() => {
        const directory = slot.temporaryDirectory;
        if (directory) {
          runInWorkerPoolContext(() => {
            const cleanup = runBestEffortCleanup({
              cleanup: async () => {
                const { removeTemporaryArtifacts } = await import("./temp-artifact-cleanup.js");
                await removeTemporaryArtifacts(directory, "Worker task");
              },
              onError: (error) =>
                process.emitWarning(
                  `Worker task cleanup could not load for ${directory}: ${String(error)}`,
                ),
            });
            // Release execution capacity at exit; terminal close still joins disposable files.
            this.artifactCleanups.add(cleanup);
            void cleanup.then(() => this.artifactCleanups.delete(cleanup));
          });
        }
        slot.worker?.removeAllListeners();
        this.slots.delete(slot);
        for (const complete of slot.completions ?? []) {
          complete();
        }
        slot.completions = undefined;
        this.dispatch();
      })
      .catch((error: unknown) => {
        // Keep native custody and queued input charges until a later close/rotation joins exit.
        slot.retirementFailed = true;
        slot.retiring = undefined;
        throw error;
      }));
  }
}
