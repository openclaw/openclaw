import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { WebSocket, type RawData } from "ws";
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "../../packages/gateway-client/src/timeouts.js";
import {
  type WorkerAdmissionResponseFrame,
  WorkerAdmissionResponseFrameSchema,
  type WorkerConnectParams,
  type WorkerConnectRequestFrame,
  type WorkerHeartbeatParams,
  type WorkerHeartbeatRequestFrame,
  type WorkerHeartbeatResponseFrame,
  WorkerHeartbeatResponseFrameSchema,
  type WorkerHelloOk,
  type WorkerLiveEventParams,
  type WorkerLiveEventRequestFrame,
  type WorkerLiveEventResponseFrame,
  WorkerLiveEventResponseFrameSchema,
  type WorkerProtocolCloseReason,
  WorkerProtocolCloseReasonSchema,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  type WorkerTranscriptCommitParams,
  type WorkerTranscriptCommitRequestFrame,
  type WorkerTranscriptCommitResponseFrame,
  WorkerTranscriptCommitResponseFrameSchema,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  type WorkerInferenceCancelParams,
  type WorkerInferenceCancelRequestFrame,
  type WorkerInferenceCancelResponseFrame,
  WorkerInferenceCancelResponseFrameSchema,
  type WorkerInferenceEventFrame,
  type WorkerInferenceStartParams,
  type WorkerInferenceStartRequestFrame,
  type WorkerInferenceStartResponseFrame,
  WorkerInferenceStartResponseFrameSchema,
  type WorkerInferenceTerminalFrame,
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  validateWorkerInferenceEventFrame,
  validateWorkerInferenceTerminalFrame,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../infra/backoff.js";
import { rawDataToString } from "../infra/ws.js";

const DEFAULT_RECONNECT_BACKOFF: BackoffPolicy = {
  initialMs: 250,
  maxMs: 30_000,
  factor: 2,
  jitter: 0,
};

const DEFAULT_ADMISSION_TIMEOUT_MS = DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const RETRYABLE_CLOSE_REASONS = new Set<WorkerProtocolCloseReason>([
  "gateway-shutdown",
  "gateway-unavailable",
]);

const FENCED_CLOSE_REASONS = new Set<WorkerProtocolCloseReason>([
  "credential-replaced",
  "owner-epoch-mismatch",
]);

export type WorkerFencedReason = "credential-replaced" | "owner-epoch-mismatch";

function isFencedCloseReason(reason: WorkerProtocolCloseReason): reason is WorkerFencedReason {
  return FENCED_CLOSE_REASONS.has(reason);
}

export type WorkerConnectionState =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "admitting"; attempt: number }
  | { kind: "ready"; hello: WorkerHelloOk }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "fenced"; reason: WorkerFencedReason }
  | { kind: "failed"; error: Error }
  | { kind: "stopped" };

export type WorkerConnectionExit =
  | { kind: "fenced"; reason: WorkerFencedReason }
  | { kind: "failed"; error: Error }
  | { kind: "stopped" };

export class WorkerConnectionInterruptedError extends Error {
  constructor(message = "worker connection interrupted") {
    super(message);
    this.name = "WorkerConnectionInterruptedError";
  }
}

export class WorkerAdmissionError extends Error {
  constructor(
    readonly reason: WorkerProtocolCloseReason,
    readonly retryable: boolean,
  ) {
    super(`worker admission rejected: ${reason}`);
    this.name = "WorkerAdmissionError";
  }
}

export class WorkerFencedError extends Error {
  constructor(readonly reason: WorkerProtocolCloseReason) {
    super(`worker fenced: ${reason}`);
    this.name = "WorkerFencedError";
  }
}

type PendingHeartbeat = {
  kind: "heartbeat";
  resolve: (frame: WorkerHeartbeatResponseFrame) => void;
  reject: (error: Error) => void;
};

type PendingTranscript = {
  kind: "transcript";
  resolve: (frame: WorkerTranscriptCommitResponseFrame) => void;
  reject: (error: Error) => void;
};

type PendingLiveEvent = {
  kind: "live-event";
  resolve: (frame: WorkerLiveEventResponseFrame) => void;
  reject: (error: Error) => void;
};

type PendingInferenceStart = {
  kind: "inference-start";
  // Durable replay can emit its terminal as the next socket frame. Reset the
  // consumer cursor synchronously after validation, before Promise continuation.
  beforeResolve?: (frame: WorkerInferenceStartResponseFrame) => void;
  resolve: (frame: WorkerInferenceStartResponseFrame) => void;
  reject: (error: Error) => void;
};

type PendingInferenceCancel = {
  kind: "inference-cancel";
  resolve: (frame: WorkerInferenceCancelResponseFrame) => void;
  reject: (error: Error) => void;
};

type PendingRequest = (
  | PendingHeartbeat
  | PendingTranscript
  | PendingLiveEvent
  | PendingInferenceStart
  | PendingInferenceCancel
) & { timeout?: ReturnType<typeof setTimeout> };

type ReadyWaiter = {
  resolve: (hello: WorkerHelloOk) => void;
  reject: (error: Error) => void;
};

export type WorkerConnectionOptions = {
  socketPath: string;
  connectParams: WorkerConnectParams;
  reconnectBackoff?: BackoffPolicy;
  admissionTimeoutMs?: number;
  requestTimeoutMs?: number;
  createSocket?: (url: string) => WebSocket;
  heartbeatStatus?: () => WorkerHeartbeatParams["status"];
};

function parseCloseReason(data: Buffer): WorkerProtocolCloseReason | undefined {
  const reason = rawDataToString(data);
  return Value.Check(WorkerProtocolCloseReasonSchema, reason) ? reason : undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resolvePositiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("worker connection timeout must be a positive safe integer");
  }
  return value;
}

function responseId(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object") {
    return undefined;
  }
  const candidate = frame as { id?: unknown; type?: unknown };
  return candidate.type === "res" && typeof candidate.id === "string" ? candidate.id : undefined;
}

export function workerSocketUrl(socketPath: string): string {
  if (!socketPath.startsWith("/")) {
    throw new Error("worker gateway socket path must be absolute");
  }
  if (socketPath.includes(":")) {
    throw new Error("worker gateway socket path must not contain a colon");
  }
  return `ws+unix://${socketPath}:/`;
}

export class WorkerConnection {
  private stateValue: WorkerConnectionState = { kind: "idle" };
  private readonly pending = new Map<string, PendingRequest>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private readonly readyListeners = new Set<(hello: WorkerHelloOk) => void>();
  private readonly stateListeners = new Set<(state: WorkerConnectionState) => void>();
  private readonly inferenceEventListeners = new Set<(frame: WorkerInferenceEventFrame) => void>();
  private readonly inferenceTerminalListeners = new Set<
    (frame: WorkerInferenceTerminalFrame) => void
  >();
  private readonly reconnectAbort = new AbortController();
  private readonly exitPromise: Promise<WorkerConnectionExit>;
  private resolveExit!: (exit: WorkerConnectionExit) => void;
  private exitSettled = false;
  private generation = 0;
  private socket: WebSocket | undefined;
  private startPromise: Promise<WorkerHelloOk> | undefined;
  private reconnectPromise: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly admissionTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: WorkerConnectionOptions) {
    this.admissionTimeoutMs = resolvePositiveTimeout(
      options.admissionTimeoutMs,
      DEFAULT_ADMISSION_TIMEOUT_MS,
    );
    this.requestTimeoutMs = resolvePositiveTimeout(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get state(): WorkerConnectionState {
    return this.stateValue;
  }

  start(): Promise<WorkerHelloOk> {
    if (this.stateValue.kind === "ready") {
      return Promise.resolve(this.stateValue.hello);
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.isTerminal()) {
      return Promise.reject(this.terminalError());
    }
    this.startPromise = this.connectUntilReady();
    return this.startPromise;
  }

  waitForExit(): Promise<WorkerConnectionExit> {
    return this.exitPromise;
  }

  waitForReady(): Promise<WorkerHelloOk> {
    if (this.stateValue.kind === "ready") {
      return Promise.resolve(this.stateValue.hello);
    }
    if (this.isTerminal()) {
      return Promise.reject(this.terminalError());
    }
    return new Promise((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject });
    });
  }

  onReady(listener: (hello: WorkerHelloOk) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  onStateChange(listener: (state: WorkerConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onInferenceEvent(listener: (frame: WorkerInferenceEventFrame) => void): () => void {
    this.inferenceEventListeners.add(listener);
    return () => this.inferenceEventListeners.delete(listener);
  }

  onInferenceTerminal(listener: (frame: WorkerInferenceTerminalFrame) => void): () => void {
    this.inferenceTerminalListeners.add(listener);
    return () => this.inferenceTerminalListeners.delete(listener);
  }

  async stop(): Promise<void> {
    if (this.stateValue.kind === "stopped") {
      return;
    }
    this.reconnectAbort.abort(new Error("worker connection stopped"));
    this.stopHeartbeat();
    const interrupted = new WorkerConnectionInterruptedError("worker connection stopped");
    this.rejectPending(interrupted);
    this.rejectReadyWaiters(interrupted);
    this.socket?.close(1000, "worker stopped");
    this.socket = undefined;
    this.transition({ kind: "stopped" });
    this.settleExit({ kind: "stopped" });
  }

  fence(reason: WorkerFencedReason): void {
    if (!this.isTerminal()) {
      this.finishFenced(reason);
    }
  }

  requestHeartbeat(params: WorkerHeartbeatParams): Promise<WorkerHeartbeatResponseFrame> {
    const id = randomUUID();
    const frame: WorkerHeartbeatRequestFrame = {
      type: "req",
      id,
      method: "worker.heartbeat",
      params,
    };
    return new Promise((resolve, reject) => {
      this.sendRequest(id, frame, { kind: "heartbeat", resolve, reject });
    });
  }

  requestTranscriptCommit(
    params: WorkerTranscriptCommitParams,
  ): Promise<WorkerTranscriptCommitResponseFrame> {
    const id = randomUUID();
    const frame: WorkerTranscriptCommitRequestFrame = {
      type: "req",
      id,
      method: "worker.transcript.commit",
      params,
    };
    return new Promise((resolve, reject) => {
      this.sendRequest(id, frame, { kind: "transcript", resolve, reject });
    });
  }

  requestLiveEvent(params: WorkerLiveEventParams): Promise<WorkerLiveEventResponseFrame> {
    const id = randomUUID();
    const frame: WorkerLiveEventRequestFrame = {
      type: "req",
      id,
      method: "worker.live-event",
      params,
    };
    return new Promise((resolve, reject) => {
      this.sendRequest(id, frame, { kind: "live-event", resolve, reject });
    });
  }

  requestInferenceStart(
    params: WorkerInferenceStartParams,
    beforeResolve?: (frame: WorkerInferenceStartResponseFrame) => void,
  ): Promise<WorkerInferenceStartResponseFrame> {
    const id = randomUUID();
    const frame: WorkerInferenceStartRequestFrame = {
      type: "req",
      id,
      method: "worker.inference.start",
      params,
    };
    return new Promise((resolve, reject) => {
      this.sendRequest(id, frame, {
        kind: "inference-start",
        ...(beforeResolve ? { beforeResolve } : {}),
        resolve,
        reject,
      });
    });
  }

  requestInferenceCancel(
    params: WorkerInferenceCancelParams,
  ): Promise<WorkerInferenceCancelResponseFrame> {
    const id = randomUUID();
    const frame: WorkerInferenceCancelRequestFrame = {
      type: "req",
      id,
      method: "worker.inference.cancel",
      params,
    };
    return new Promise((resolve, reject) => {
      this.sendRequest(id, frame, { kind: "inference-cancel", resolve, reject });
    });
  }

  private async connectUntilReady(): Promise<WorkerHelloOk> {
    let attempt = 0;
    while (!this.isTerminal()) {
      if (attempt > 0) {
        this.transition({ kind: "reconnecting", attempt });
        try {
          await sleepWithAbort(
            computeBackoff(this.options.reconnectBackoff ?? DEFAULT_RECONNECT_BACKOFF, attempt),
            this.reconnectAbort.signal,
          );
        } catch (error) {
          throw this.isTerminal() ? this.terminalError() : toError(error);
        }
      }
      try {
        return await this.connectOnce(attempt);
      } catch (error) {
        if (error instanceof WorkerAdmissionError) {
          if (error.retryable) {
            attempt += 1;
            continue;
          }
          this.handleAdmissionFailure(error);
          throw error;
        }
        if (this.isTerminal()) {
          throw this.terminalError();
        }
        attempt += 1;
      }
    }
    throw this.terminalError();
  }

  private connectOnce(attempt: number): Promise<WorkerHelloOk> {
    const generation = ++this.generation;
    this.transition({ kind: "connecting", attempt });
    const socket = this.options.createSocket
      ? this.options.createSocket(workerSocketUrl(this.options.socketPath))
      : new WebSocket(workerSocketUrl(this.options.socketPath), {
          maxPayload: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
        });
    this.socket = socket;
    const admissionId = randomUUID();
    let admitted = false;
    let attemptSettled = false;

    return new Promise<WorkerHelloOk>((resolve, reject) => {
      let attemptTimeout: ReturnType<typeof setTimeout> | undefined;
      const rejectAttempt = (error: Error) => {
        if (attemptSettled) {
          return;
        }
        attemptSettled = true;
        if (attemptTimeout) {
          clearTimeout(attemptTimeout);
          attemptTimeout = undefined;
        }
        reject(error);
      };
      attemptTimeout = setTimeout(() => {
        rejectAttempt(new WorkerConnectionInterruptedError("worker admission timed out"));
        socket.terminate();
      }, this.admissionTimeoutMs);
      attemptTimeout.unref?.();

      socket.on("error", (error) => {
        if (!admitted) {
          rejectAttempt(new WorkerConnectionInterruptedError(toError(error).message));
        }
      });
      socket.on("open", () => {
        if (generation !== this.generation || this.isTerminal()) {
          socket.close();
          return;
        }
        this.transition({ kind: "admitting", attempt });
        const frame: WorkerConnectRequestFrame = {
          type: "req",
          id: admissionId,
          method: "connect",
          params: {
            ...this.options.connectParams,
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
          },
        };
        socket.send(JSON.stringify(frame), (error) => {
          if (error) {
            rejectAttempt(new WorkerConnectionInterruptedError(error.message));
            socket.terminate();
          }
        });
      });
      socket.on("message", (data: RawData) => {
        if (generation !== this.generation) {
          return;
        }
        const parsed = this.parseFrame(data);
        if (!parsed.ok) {
          this.closeInvalidFrame(socket);
          return;
        }
        const frame = parsed.frame;
        if (!admitted) {
          if (
            !Value.Check(WorkerAdmissionResponseFrameSchema, frame) ||
            (frame as WorkerAdmissionResponseFrame).id !== admissionId
          ) {
            this.closeInvalidFrame(socket);
            rejectAttempt(new WorkerAdmissionError("invalid-handshake", false));
            return;
          }
          const response = frame as WorkerAdmissionResponseFrame;
          if (!response.ok) {
            const reason = response.error.details.reason;
            rejectAttempt(
              new WorkerAdmissionError(
                reason,
                response.error.retryable === true && RETRYABLE_CLOSE_REASONS.has(reason),
              ),
            );
            socket.terminate();
            return;
          }
          if (!this.matchesAdmission(response.payload)) {
            this.closeInvalidFrame(socket);
            rejectAttempt(new WorkerAdmissionError("invalid-handshake", false));
            return;
          }
          admitted = true;
          attemptSettled = true;
          if (attemptTimeout) {
            clearTimeout(attemptTimeout);
            attemptTimeout = undefined;
          }
          this.transition({ kind: "ready", hello: response.payload });
          this.notifyReady(response.payload);
          this.startHeartbeat(response.payload.policy.heartbeatIntervalMs);
          resolve(response.payload);
          return;
        }
        this.dispatchReadyFrame(frame, socket);
      });
      socket.on("close", (_code, reason) => {
        if (generation !== this.generation) {
          return;
        }
        this.stopHeartbeat();
        this.socket = undefined;
        const interrupted = new WorkerConnectionInterruptedError();
        this.rejectPending(interrupted);
        const closeReason = parseCloseReason(reason);
        if (!admitted) {
          rejectAttempt(
            closeReason
              ? new WorkerAdmissionError(closeReason, RETRYABLE_CLOSE_REASONS.has(closeReason))
              : interrupted,
          );
          return;
        }
        this.handleReadyClose(closeReason);
      });
    });
  }

  private parseFrame(data: RawData): { ok: true; frame: unknown } | { ok: false } {
    try {
      return { ok: true, frame: JSON.parse(rawDataToString(data)) as unknown };
    } catch {
      return { ok: false };
    }
  }

  private matchesAdmission(hello: WorkerHelloOk): boolean {
    const expected = this.options.connectParams.admission;
    return (
      hello.environmentId === expected.environmentId &&
      hello.sessionId === expected.sessionId &&
      hello.ownerEpoch === expected.ownerEpoch &&
      hello.rpcSetVersion === expected.rpcSetVersion &&
      hello.protocolFeatures.length === expected.handshake.protocolFeatures.length &&
      hello.protocolFeatures.every((feature) =>
        expected.handshake.protocolFeatures.includes(feature),
      )
    );
  }

  private dispatchReadyFrame(frame: unknown, socket: WebSocket): void {
    if (validateWorkerInferenceEventFrame(frame)) {
      if (!this.matchesInferenceIdentity(frame.payload)) {
        this.closeInvalidFrame(socket);
        return;
      }
      for (const listener of this.inferenceEventListeners) {
        listener(frame);
      }
      return;
    }
    if (validateWorkerInferenceTerminalFrame(frame)) {
      if (!this.matchesInferenceIdentity(frame.payload)) {
        this.closeInvalidFrame(socket);
        return;
      }
      for (const listener of this.inferenceTerminalListeners) {
        listener(frame);
      }
      return;
    }
    const id = responseId(frame);
    const pending = id ? this.pending.get(id) : undefined;
    if (!id || !pending) {
      this.closeInvalidFrame(socket);
      return;
    }
    if (!this.resolvePendingFrame(id, pending, frame)) {
      this.closeInvalidFrame(socket);
    }
  }

  private matchesInferenceIdentity(payload: { runEpoch: number; sessionId: string }): boolean {
    const admission = this.options.connectParams.admission;
    return payload.runEpoch === admission.ownerEpoch && payload.sessionId === admission.sessionId;
  }

  private resolvePendingFrame(id: string, pending: PendingRequest, frame: unknown): boolean {
    switch (pending.kind) {
      case "heartbeat": {
        if (!Value.Check(WorkerHeartbeatResponseFrameSchema, frame)) {
          return false;
        }
        this.deletePending(id, pending);
        pending.resolve(frame as WorkerHeartbeatResponseFrame);
        return true;
      }
      case "transcript": {
        if (!Value.Check(WorkerTranscriptCommitResponseFrameSchema, frame)) {
          return false;
        }
        this.deletePending(id, pending);
        pending.resolve(frame as WorkerTranscriptCommitResponseFrame);
        return true;
      }
      case "live-event": {
        if (!Value.Check(WorkerLiveEventResponseFrameSchema, frame)) {
          return false;
        }
        this.deletePending(id, pending);
        pending.resolve(frame as WorkerLiveEventResponseFrame);
        return true;
      }
      case "inference-start": {
        if (!Value.Check(WorkerInferenceStartResponseFrameSchema, frame)) {
          return false;
        }
        const response = frame as WorkerInferenceStartResponseFrame;
        this.deletePending(id, pending);
        try {
          pending.beforeResolve?.(response);
        } catch (error) {
          pending.reject(toError(error));
          return true;
        }
        pending.resolve(response);
        return true;
      }
      case "inference-cancel": {
        if (!Value.Check(WorkerInferenceCancelResponseFrameSchema, frame)) {
          return false;
        }
        this.deletePending(id, pending);
        pending.resolve(frame as WorkerInferenceCancelResponseFrame);
        return true;
      }
    }
    return false;
  }

  private sendRequest(id: string, frame: object, pending: PendingRequest): void {
    if (
      this.stateValue.kind !== "ready" ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      pending.reject(new WorkerConnectionInterruptedError("worker connection is not ready"));
      return;
    }
    if (this.pending.has(id)) {
      pending.reject(new Error("worker request id collision"));
      return;
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(frame);
    } catch (error) {
      pending.reject(toError(error));
      return;
    }
    const payloadLimit =
      pending.kind === "inference-start"
        ? WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES
        : WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
    if (Buffer.byteLength(encoded, "utf8") > payloadLimit) {
      pending.reject(new Error("worker request exceeds the protocol payload limit"));
      return;
    }
    const socket = this.socket;
    this.pending.set(id, pending);
    pending.timeout = setTimeout(() => {
      if (!this.deletePending(id, pending)) {
        return;
      }
      pending.reject(
        new WorkerConnectionInterruptedError(`worker ${pending.kind} response timed out`),
      );
      this.interruptReadySocket(socket);
    }, this.requestTimeoutMs);
    pending.timeout.unref?.();
    try {
      socket.send(encoded, (error) => {
        if (!error || this.pending.get(id) !== pending) {
          return;
        }
        this.deletePending(id, pending);
        pending.reject(new WorkerConnectionInterruptedError(error.message));
        this.interruptReadySocket(socket);
      });
    } catch (error) {
      this.deletePending(id, pending);
      pending.reject(new WorkerConnectionInterruptedError(toError(error).message));
      this.interruptReadySocket(socket);
    }
  }

  private handleReadyClose(reason: WorkerProtocolCloseReason | undefined): void {
    if (this.isTerminal()) {
      return;
    }
    if (reason && isFencedCloseReason(reason)) {
      this.finishFenced(reason);
      return;
    }
    if (reason && !RETRYABLE_CLOSE_REASONS.has(reason)) {
      this.finishFailed(new WorkerAdmissionError(reason, false));
      return;
    }
    if (!this.reconnectPromise) {
      this.reconnectPromise = this.reconnectAfterClose();
    }
  }

  private async reconnectAfterClose(): Promise<void> {
    try {
      await this.connectUntilReady();
    } catch (error) {
      if (!this.isTerminal()) {
        this.finishFailed(toError(error));
      }
    } finally {
      this.reconnectPromise = undefined;
    }
  }

  private handleAdmissionFailure(error: WorkerAdmissionError): void {
    if (isFencedCloseReason(error.reason)) {
      this.finishFenced(error.reason);
      return;
    }
    this.finishFailed(error);
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      void this.sendHeartbeat();
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.stateValue.kind !== "ready") {
      return;
    }
    const intervalMs = this.stateValue.hello.policy.heartbeatIntervalMs;
    try {
      const response = await this.requestHeartbeat({
        sentAtMs: Date.now(),
        status: this.options.heartbeatStatus?.() ?? "ready",
      });
      if (response.ok) {
        if (response.payload.ownerEpoch !== this.options.connectParams.admission.ownerEpoch) {
          this.finishFenced("owner-epoch-mismatch");
          return;
        }
      } else if (isFencedCloseReason(response.error.details.reason)) {
        this.finishFenced(response.error.details.reason);
        return;
      } else {
        this.finishFailed(new Error(`worker heartbeat rejected: ${response.error.details.reason}`));
        return;
      }
    } catch (error) {
      if (!(error instanceof WorkerConnectionInterruptedError) && !this.isTerminal()) {
        this.finishFailed(toError(error));
        return;
      }
    }
    if (this.stateValue.kind === "ready") {
      this.startHeartbeat(intervalMs);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private closeInvalidFrame(socket: WebSocket): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1008, "invalid-frame");
    }
  }

  private interruptReadySocket(socket: WebSocket): void {
    if (this.socket === socket && this.stateValue.kind === "ready") {
      this.transition({ kind: "reconnecting", attempt: 0 });
    }
    socket.terminate();
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      if (request.timeout) {
        clearTimeout(request.timeout);
        request.timeout = undefined;
      }
      request.reject(error);
    }
  }

  private deletePending(id: string, pending: PendingRequest): boolean {
    if (this.pending.get(id) !== pending) {
      return false;
    }
    this.pending.delete(id);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }
    return true;
  }

  private notifyReady(hello: WorkerHelloOk): void {
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const waiter of waiters) {
      waiter.resolve(hello);
    }
    for (const listener of this.readyListeners) {
      listener(hello);
    }
  }

  private transition(state: WorkerConnectionState): void {
    this.stateValue = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  private finishFenced(reason: WorkerFencedReason): void {
    this.stopHeartbeat();
    const error = new WorkerFencedError(reason);
    this.rejectPending(error);
    this.rejectReadyWaiters(error);
    this.socket?.close(1008, reason);
    this.transition({ kind: "fenced", reason });
    this.settleExit({ kind: "fenced", reason });
  }

  private finishFailed(error: Error): void {
    this.stopHeartbeat();
    this.rejectPending(error);
    this.rejectReadyWaiters(error);
    this.socket?.close(1008, "invalid-frame");
    this.transition({ kind: "failed", error });
    this.settleExit({ kind: "failed", error });
  }

  private rejectReadyWaiters(error: Error): void {
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private settleExit(exit: WorkerConnectionExit): void {
    if (this.exitSettled) {
      return;
    }
    this.exitSettled = true;
    this.resolveExit(exit);
  }

  private isTerminal(): boolean {
    return (
      this.stateValue.kind === "failed" ||
      this.stateValue.kind === "fenced" ||
      this.stateValue.kind === "stopped"
    );
  }

  private terminalError(): Error {
    if (this.stateValue.kind === "failed") {
      return this.stateValue.error;
    }
    if (this.stateValue.kind === "fenced") {
      return new WorkerFencedError(this.stateValue.reason);
    }
    return new WorkerConnectionInterruptedError("worker connection stopped");
  }
}

export function createWorkerConnection(options: WorkerConnectionOptions): WorkerConnection {
  return new WorkerConnection(options);
}
