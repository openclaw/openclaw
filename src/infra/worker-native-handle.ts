import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import type { MessagePort, Transferable, Worker } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { runWithMainThreadTask } from "./main-thread-stall.js";
import { trackNativeWorkerForCpu } from "./worker-cpu.js";
import { decodeNativeWorkerFailure } from "./worker-native-error.js";
import type {
  NativeWorkerEvents,
  NativeWorkerRuntime,
  NativeWorkerReply,
  NativeWorkerRequest,
  NativeWorkerResourceConnection,
  NativeWorkerResourceDescriptor,
  RetainedNativeWorker,
} from "./worker-native-lifecycle.types.js";
import { bindNativeWorkerResource } from "./worker-native-resource.js";
import { NativeWorkerTaskPort } from "./worker-native-task-port.js";
import { workerRequestKind } from "./worker-request-kind.js";

type HeapStatistics = Awaited<ReturnType<Worker["getHeapStatistics"]>>;
type NativeDelivery =
  | NativeWorkerReply
  | { type: "owner-failed"; error: Error }
  | { type: "owner-joined"; error: Error }
  | { type: "resource-failed"; error: unknown; diagnostic: Error };

export class NativeWorker extends EventEmitter<NativeWorkerEvents> implements RetainedNativeWorker {
  // Match native Worker callbacks even when a different caller services this port.
  private readonly runInContext = AsyncLocalStorage.snapshot();
  threadId = 0;
  started = false;
  executionStopped = false;
  private referenced = true;
  private stopping = false;
  private joined = false;
  private servicingResource = false;
  private resourceBinding?: ReturnType<typeof bindNativeWorkerResource>;
  private resourceClosed = false;
  private supervisorJoined = false;
  private resourceRecovery?: Promise<void>;
  // Preserve one caller retry across the current close attempt's terminal failure.
  private resourceRetryRequested = false;
  private readonly taskPort?: NativeWorkerTaskPort;
  private readonly deliveries: NativeDelivery[] = [];
  private terminalObserved = false;
  private observingTaskPortLoss = false;
  private taskPortLossReported = false;
  private requestId = 0;
  private stopCompletion = createRetainedOperation<void>(() => this.service());
  private readonly cpuRequests = new Map<
    number,
    ReturnType<typeof createRetainedOperation<NodeJS.CpuUsage>>
  >();
  private readonly heapRequests = new Map<
    number,
    ReturnType<typeof createRetainedOperation<HeapStatistics>>
  >();

  constructor(
    private readonly runtime: NativeWorkerRuntime,
    readonly id: number,
    private readonly filename: string | URL,
    private readonly evalSource: boolean,
    private readonly ownsNativeResource: boolean,
    private readonly resourceConnection?: NativeWorkerResourceConnection,
    taskPort?: MessagePort,
  ) {
    super();
    if (taskPort) {
      const label = `worker:${
        !evalSource && filename instanceof URL ? workerRequestKind(filename) : "other"
      }`;
      this.taskPort = new NativeWorkerTaskPort(taskPort, {
        message: (value) =>
          this.runInContext(() => runWithMainThreadTask(label, () => this.emit("message", value))),
        messageerror: (error) => this.runInContext(() => this.emit("messageerror", error)),
        unavailable: () => this.observeTaskPortLoss(),
      });
    }
  }

  get needsReference(): boolean {
    return (
      this.referenced ||
      this.stopping ||
      (this.executionStopped && this.ownsNativeResource && !this.joined) ||
      this.cpuRequests.size > 0 ||
      this.heapRequests.size > 0
    );
  }

  service(): void {
    this.runtime.service();
  }

  serviceTaskPort(): void {
    if (!this.taskPort) {
      return;
    }
    this.drainDeliveries();
    this.taskPort.service();
    this.observeTaskPortLoss();
  }

  private observeTaskPortLoss(): void {
    const failure = this.taskPort?.failure;
    if (
      !failure ||
      !this.referenced ||
      this.observingTaskPortLoss ||
      this.taskPortLossReported ||
      this.terminalObserved ||
      this.stopping ||
      this.joined ||
      this.executionStopped ||
      this.runtime.failure
    ) {
      return;
    }
    this.observingTaskPortLoss = true;
    try {
      // A close on the data channel can precede an already queued native error or exit.
      this.runtime.service();
      if (
        this.started &&
        this.referenced &&
        !this.terminalObserved &&
        !this.stopping &&
        !this.joined &&
        !this.executionStopped &&
        !this.runtime.failure
      ) {
        this.taskPortLossReported = true;
        this.runInContext(() => this.emit("error", failure));
      }
    } finally {
      this.observingTaskPortLoss = false;
    }
  }

  serviceResource(): void {
    if (!this.resourceBinding || this.servicingResource || this.joined) {
      return;
    }
    this.servicingResource = true;
    try {
      this.resourceBinding.service();
    } catch (error) {
      this.deliver({
        type: "resource-failed",
        error,
        diagnostic: toErrorObject(error, "Native resource observation failed"),
      });
    } finally {
      this.servicingResource = false;
    }
  }

  attachResource(descriptor: NativeWorkerResourceDescriptor) {
    this.resourceBinding = bindNativeWorkerResource({
      broker: this.runtime.resourceBroker(),
      descriptor,
      connection: this.resourceConnection,
      supervisorAvailable: () => !this.runtime.failure,
      postOwnerMessage: (value, sequence) =>
        this.runtime.post({ type: "resource-owner", id: this.id, sequence, value }),
      closed: () =>
        this.runInContext(() => {
          this.resourceClosed = true;
          if (this.supervisorJoined) {
            this.finishJoined(undefined);
          }
        }),
      failed: (error) => this.deliver({ type: "resource-failed", error, diagnostic: error }),
    });
    return { workerDataKey: descriptor.workerDataKey, attachment: this.resourceBinding.attachment };
  }

  abandonResource(): void {
    this.taskPort?.close();
    if (this.resourceBinding) {
      this.resourceBinding.abandonUnattached();
    } else {
      this.resourceConnection?.dispose();
    }
  }

  private recoverResource(requestRetry = false): void {
    if (!this.resourceBinding || this.joined) {
      return;
    }
    if (this.resourceRecovery) {
      this.resourceRetryRequested ||= requestRetry;
      return;
    }
    this.resourceRetryRequested = false;
    const recovery = this.resourceBinding.closeAfterSupervisor();
    this.resourceRecovery = recovery;
    void recovery.then(
      () =>
        this.runInContext(() => {
          this.resourceRecovery = undefined;
          this.resourceRetryRequested = false;
          this.finishJoined(undefined);
        }),
      (error: unknown) =>
        this.runInContext(() => {
          this.resourceRecovery = undefined;
          this.stopping = false;
          this.stopCompletion.reject(error);
          if (this.resourceRetryRequested) {
            this.recoverResource();
          }
        }),
    );
  }

  postMessage(value: unknown, transferList: readonly Transferable[] = []): void {
    if (this.joined || this.stopping || this.executionStopped) {
      throw new Error("Native worker is closing");
    }
    if (this.runtime.failure) {
      throw this.runtime.failure;
    }
    if (this.taskPort) {
      this.taskPort.postMessage(value, transferList);
      return;
    }
    this.runtime.post(
      { type: "post", id: this.id, value, transferList: [...transferList] },
      transferList,
    );
  }

  ref(): this {
    if (this.runtime.failure) {
      throw this.runtime.failure;
    }
    this.taskPort?.assertAvailable();
    if (!this.referenced) {
      this.runtime.post({ type: "ref", id: this.id, referenced: true });
      this.referenced = true;
    }
    this.runtime.refreshReference();
    return this;
  }

  unref(): this {
    const wasReferenced = this.referenced;
    this.referenced = false;
    if (!this.joined) {
      if (this.runtime.failure) {
        throw this.runtime.failure;
      }
      if (wasReferenced) {
        this.runtime.post({ type: "ref", id: this.id, referenced: false });
      }
    }
    this.runtime.refreshReference();
    return this;
  }

  stop() {
    if (this.joined) {
      if (this.stopCompletion.operation.read().status !== "fulfilled") {
        this.stopCompletion = createRetainedOperation<void>(() => this.service());
        this.stopCompletion.resolve();
      }
      return this.stopCompletion.operation;
    }
    if (this.stopCompletion.operation.read().status === "rejected") {
      this.stopCompletion = createRetainedOperation<void>(() => this.service());
    }
    if (this.supervisorJoined && this.resourceBinding) {
      this.stopCompletion.reject(
        new Error("Native resource cleanup is still retained after supervisor loss", {
          cause: this.runtime.failure,
        }),
      );
      this.recoverResource(true);
      return this.stopCompletion.operation;
    }
    if (!this.stopping) {
      this.stopping = true;
      try {
        this.runtime.post({ type: "stop", id: this.id });
      } catch (error) {
        this.stopping = false;
        this.stopCompletion.reject(error);
      }
      this.runtime.refreshReference();
    }
    return this.stopCompletion.operation;
  }

  terminate(): Promise<void> {
    return this.stop().result;
  }

  cpuUsage(previous?: NodeJS.CpuUsage): Promise<NodeJS.CpuUsage> {
    return this.requestSample(this.cpuRequests, { type: "cpu", previous });
  }

  getHeapStatistics(): Promise<HeapStatistics> {
    return this.requestSample(this.heapRequests, { type: "heap" });
  }

  private requestSample<T>(
    requests: Map<number, ReturnType<typeof createRetainedOperation<T>>>,
    request:
      | Omit<Extract<NativeWorkerRequest, { type: "cpu" }>, "id" | "requestId">
      | Omit<Extract<NativeWorkerRequest, { type: "heap" }>, "id" | "requestId">,
  ): Promise<T> {
    if (this.joined) {
      return Promise.reject(new Error("Native worker exited"));
    }
    const pending = createRetainedOperation<T>(() => this.service());
    const requestId = ++this.requestId;
    requests.set(requestId, pending);
    try {
      this.runtime.post({ ...request, id: this.id, requestId });
    } catch (error) {
      requests.delete(requestId);
      pending.reject(error);
    }
    this.runtime.refreshReference();
    return pending.operation.result;
  }

  private rejectSamples(error: Error): void {
    for (const pending of [...this.cpuRequests.values(), ...this.heapRequests.values()]) {
      pending.reject(error);
    }
    this.cpuRequests.clear();
    this.heapRequests.clear();
  }

  ownerFailed(error: Error): void {
    this.deliver({ type: "owner-failed", error });
  }

  private receiveOwnerFailure(error: Error): void {
    this.runInContext(() => {
      this.taskPort?.close();
      this.stopping = false;
      this.rejectSamples(error);
      this.stopCompletion.reject(error);
      this.emit("error", error);
    });
  }

  ownerJoined(error: Error): void {
    this.deliver({ type: "owner-joined", error });
  }

  private receiveOwnerJoin(error: Error): void {
    this.runInContext(() => {
      this.stopping = false;
      this.supervisorJoined = true;
      this.rejectSamples(error);
      this.finishExecution(undefined);
      if (this.ownsNativeResource) {
        if (this.resourceClosed) {
          this.finishJoined(undefined);
          return;
        }
        this.stopCompletion.reject(
          new Error("Native resource cleanup outcome is unavailable after owner loss", {
            cause: error,
          }),
        );
        this.recoverResource();
        return;
      }
      this.finishJoined(undefined);
    });
  }

  private finishJoined(code: number | undefined): void {
    if (this.joined) {
      return;
    }
    this.joined = true;
    this.taskPort?.close();
    this.threadId = -1;
    this.stopping = false;
    this.referenced = false;
    this.rejectSamples(new Error("Native worker exited"));
    this.stopCompletion.resolve();
    this.runtime.handles.delete(this.id);
    if (!this.runtime.failure) {
      this.runtime.post({ type: "release", id: this.id });
    }
    this.runtime.refreshReference();
    if (this.resourceBinding) {
      this.resourceBinding.release();
    } else {
      this.resourceConnection?.dispose();
    }
    this.finishExecution(code);
    this.emit("exit", code);
  }

  private finishExecution(code: number | undefined): void {
    if (!this.executionStopped) {
      this.taskPort?.close();
      this.executionStopped = true;
      this.emit("execution-exit", code);
    }
  }

  receive(reply: NativeWorkerReply): void {
    this.deliver(reply);
  }

  private deliver(delivery: NativeDelivery): void {
    this.deliveries.push(delivery);
    this.drainDeliveries();
  }

  private drainDeliveries(): void {
    this.runInContext(() => {
      for (;;) {
        const delivery = this.deliveries[0];
        if (!delivery) {
          return;
        }
        if (
          delivery.type === "error" ||
          delivery.type === "messageerror" ||
          delivery.type === "create-error" ||
          delivery.type === "execution-exit" ||
          delivery.type === "stopped" ||
          delivery.type === "stop-error" ||
          delivery.type === "resource-failed" ||
          delivery.type === "owner-failed" ||
          delivery.type === "owner-joined"
        ) {
          this.terminalObserved = true;
          this.taskPort?.drain();
          // Reentrant service may have delivered this same terminal receipt while draining data.
          if (this.deliveries[0] !== delivery) {
            continue;
          }
        }
        this.deliveries.shift();
        if (delivery.type === "owner-failed") {
          this.receiveOwnerFailure(delivery.error);
        } else if (delivery.type === "owner-joined") {
          this.receiveOwnerJoin(delivery.error);
        } else if (delivery.type === "resource-failed") {
          this.stopCompletion.reject(delivery.error);
          this.emit("error", delivery.diagnostic);
        } else {
          this.receiveOwned(delivery);
        }
      }
    });
  }

  private receiveOwned(reply: NativeWorkerReply): void {
    if (reply.type === "created") {
      this.started = true;
      this.threadId = reply.threadId;
      trackNativeWorkerForCpu(this, this.filename, this.evalSource);
      this.taskPort?.start();
      this.emit("started");
      this.taskPort?.drain();
      this.observeTaskPortLoss();
    } else if (reply.type === "message") {
      this.emit("message", reply.value);
    } else if (reply.type === "resource-message") {
      this.resourceBinding?.receive(reply.response);
    } else if (reply.type === "error" || reply.type === "messageerror") {
      this.emit(
        reply.type,
        toErrorObject(decodeNativeWorkerFailure(reply.error), "Native worker failed"),
      );
    } else if (reply.type === "create-error") {
      // A constructor refusal has no native Worker to join and emits no fake exit.
      this.joined = true;
      this.threadId = -1;
      this.referenced = false;
      const error = toErrorObject(
        decodeNativeWorkerFailure(reply.error),
        "Native worker creation failed",
      );
      this.rejectSamples(error);
      this.stopCompletion.resolve();
      this.runtime.handles.delete(this.id);
      this.runtime.refreshReference();
      this.abandonResource();
      this.emit("error", error);
    } else if (reply.type === "stopped") {
      this.finishJoined(reply.code);
    } else if (reply.type === "execution-exit") {
      this.finishExecution(reply.code);
    } else if (reply.type === "stop-error") {
      const requestedStop = this.stopping;
      this.stopping = false;
      let error: Error;
      try {
        if (reply.resourceError) {
          if (!this.resourceConnection?.decodeCloseError) {
            throw new Error("Native resource cleanup error decoder is unavailable", {
              cause: reply.error,
            });
          }
          error = this.resourceConnection.decodeCloseError(reply.error);
        } else {
          error = toErrorObject(
            decodeNativeWorkerFailure(reply.error),
            "Native worker stop failed",
          );
        }
      } catch (decodeError) {
        error = toErrorObject(decodeError, "Native resource cleanup error decoding failed");
      }
      this.stopCompletion.reject(error);
      if (!requestedStop) {
        // An unsolicited exit can fail resource cleanup before the pool has
        // requested retirement. Its active task must still observe the failure.
        this.emit("error", error);
      }
    } else if (reply.type === "cpu") {
      this.cpuRequests.get(reply.requestId)?.resolve(reply.value);
      this.cpuRequests.delete(reply.requestId);
    } else if (reply.type === "heap") {
      this.heapRequests.get(reply.requestId)?.resolve(reply.value);
      this.heapRequests.delete(reply.requestId);
    } else if (reply.type === "request-error") {
      const error = toErrorObject(
        decodeNativeWorkerFailure(reply.error),
        "Native worker observation failed",
      );
      this.cpuRequests.get(reply.requestId)?.reject(error);
      this.heapRequests.get(reply.requestId)?.reject(error);
      this.cpuRequests.delete(reply.requestId);
      this.heapRequests.delete(reply.requestId);
    }
    this.runtime.refreshReference();
  }
}
