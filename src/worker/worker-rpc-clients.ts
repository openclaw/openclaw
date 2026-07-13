import type {
  WorkerErrorShape,
  WorkerLiveEvent,
  WorkerLiveEventErrorShape,
  WorkerLiveEventResult,
  WorkerTranscriptCommitErrorShape,
  WorkerTranscriptCommitRequestFrame,
  WorkerTranscriptCommitResult,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceCancelParams,
  WorkerInferenceCancelResult,
  WorkerInferenceErrorShape,
  WorkerInferenceEventParams,
  WorkerInferenceStartParams,
  WorkerInferenceTerminalOutcome,
  WorkerInferenceTerminalParams,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { isWorkerTranscriptMessageFrameSafe } from "./transcript-message.js";
import {
  type WorkerConnection,
  WorkerConnectionInterruptedError,
  WorkerConnectionStoppedError,
  WorkerFencedError,
} from "./worker-connection.js";

type TranscriptResponseError = WorkerTranscriptCommitErrorShape | WorkerErrorShape;
type LiveResponseError = WorkerLiveEventErrorShape | WorkerErrorShape;
type InferenceResponseError = WorkerInferenceErrorShape | WorkerErrorShape;
const TRANSCRIPT_SIZE_FRAME_ID = "00000000-0000-4000-8000-000000000000";

function fenceForOwnershipError(
  connection: WorkerConnection,
  response: TranscriptResponseError | LiveResponseError | InferenceResponseError,
): void {
  const reason = response.details.reason;
  if (reason === "epoch-mismatch" || reason === "owner-epoch-mismatch") {
    connection.fence("owner-epoch-mismatch");
  } else if (reason === "credential-replaced") {
    connection.fence("credential-replaced");
  }
}

function isTerminalConnection(connection: WorkerConnection): boolean {
  return (
    connection.state.kind === "fenced" ||
    connection.state.kind === "failed" ||
    connection.state.kind === "stopped"
  );
}

export class WorkerTranscriptCommitError extends Error {
  constructor(readonly response: TranscriptResponseError) {
    super(response.message);
    this.name = "WorkerTranscriptCommitError";
  }

  get reason(): TranscriptResponseError["details"]["reason"] {
    return this.response.details.reason;
  }
}

export class WorkerTranscriptResyncError extends WorkerTranscriptCommitError {
  constructor(
    response: WorkerTranscriptCommitErrorShape & {
      details: { reason: "stale-base-leaf" };
    },
    readonly baseLeafId: string | null,
    readonly seq: number,
    readonly nextSeq: number,
  ) {
    super(response);
    this.name = "WorkerTranscriptResyncError";
  }
}

export type WorkerTranscriptCommitClientOptions = {
  runEpoch: number;
  baseLeafId: string | null;
  initialSeq?: number;
};

export type WorkerTranscriptResumeState = {
  baseLeafId: string | null;
  nextSeq: number;
};

export class WorkerTranscriptCommitClient {
  private baseLeafIdValue: string | null;
  private nextSeqValue: number;
  private queue: Promise<void> = Promise.resolve();
  private pendingResync: WorkerTranscriptResyncError | undefined;

  constructor(
    private readonly connection: WorkerConnection,
    private readonly options: WorkerTranscriptCommitClientOptions,
  ) {
    this.baseLeafIdValue = options.baseLeafId;
    this.nextSeqValue = options.initialSeq ?? 1;
  }

  get baseLeafId(): string | null {
    return this.baseLeafIdValue;
  }

  get nextSeq(): number {
    return this.nextSeqValue;
  }

  resumeFromBase(state: WorkerTranscriptResumeState): void {
    if (!Number.isSafeInteger(state.nextSeq) || state.nextSeq < this.nextSeqValue) {
      throw new Error("worker transcript resume sequence moved backwards");
    }
    this.baseLeafIdValue = state.baseLeafId;
    this.nextSeqValue = state.nextSeq;
    this.pendingResync = undefined;
  }

  commit(messages: readonly WorkerTranscriptMessage[]): Promise<WorkerTranscriptCommitResult> {
    const snapshot = structuredClone(messages);
    const operation = this.queue.then(() => this.commitBatches(snapshot));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async commitBatches(
    messages: readonly WorkerTranscriptMessage[],
  ): Promise<WorkerTranscriptCommitResult> {
    if (messages.length === 0) {
      throw new Error("worker transcript commit requires at least one message");
    }
    const entryIds: string[] = [];
    let offset = 0;
    while (offset < messages.length) {
      const batch = this.takeFittingBatch(messages.slice(offset));
      const result = await this.commitBatch(batch);
      entryIds.push(...result.entryIds);
      offset += batch.length;
    }
    const newLeafId = this.baseLeafIdValue;
    if (newLeafId === null) {
      throw new Error("worker transcript commit did not advance the base leaf");
    }
    return { entryIds, newLeafId };
  }

  private takeFittingBatch(
    messages: readonly WorkerTranscriptMessage[],
  ): WorkerTranscriptMessage[] {
    let batch: WorkerTranscriptMessage[] = [];
    for (const message of messages) {
      if (!isWorkerTranscriptMessageFrameSafe(message)) {
        throw new Error("worker transcript message exceeds the protocol payload limit");
      }
      const candidate = [...batch, message];
      const frame: WorkerTranscriptCommitRequestFrame = {
        type: "req",
        id: TRANSCRIPT_SIZE_FRAME_ID,
        method: "worker.transcript.commit",
        params: {
          runEpoch: this.options.runEpoch,
          seq: this.nextSeqValue,
          baseLeafId: this.baseLeafIdValue,
          messages: candidate,
        },
      };
      if (Buffer.byteLength(JSON.stringify(frame), "utf8") > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) {
        if (batch.length === 0) {
          throw new Error("worker transcript message exceeds the protocol payload limit");
        }
        break;
      }
      batch = candidate;
    }
    return batch;
  }

  private async commitBatch(
    messages: readonly WorkerTranscriptMessage[],
  ): Promise<WorkerTranscriptCommitResult> {
    if (this.pendingResync) {
      throw this.pendingResync;
    }
    const request = {
      runEpoch: this.options.runEpoch,
      seq: this.nextSeqValue,
      baseLeafId: this.baseLeafIdValue,
      messages: [...messages],
    };
    while (true) {
      await this.connection.waitForReady();
      try {
        const response = await this.connection.requestTranscriptCommit(request);
        if (response.ok) {
          this.baseLeafIdValue = response.payload.newLeafId;
          this.nextSeqValue = request.seq + 1;
          return response.payload;
        }
        if (response.error.details.reason === "stale-base-leaf") {
          // Transcript failures are terminal ledger entries and consume seq.
          // Block until the launcher supplies a fresh authoritative base.
          this.nextSeqValue = request.seq + 1;
          this.pendingResync = new WorkerTranscriptResyncError(
            response.error as WorkerTranscriptCommitErrorShape & {
              details: { reason: "stale-base-leaf" };
            },
            request.baseLeafId,
            request.seq,
            this.nextSeqValue,
          );
          throw this.pendingResync;
        }
        fenceForOwnershipError(this.connection, response.error);
        throw new WorkerTranscriptCommitError(response.error);
      } catch (error) {
        if (
          error instanceof WorkerConnectionInterruptedError &&
          !isTerminalConnection(this.connection)
        ) {
          continue;
        }
        throw error;
      }
    }
  }
}

export class WorkerLiveEventError extends Error {
  constructor(readonly response: LiveResponseError) {
    super(response.message);
    this.name = "WorkerLiveEventError";
  }

  get reason(): LiveResponseError["details"]["reason"] {
    return this.response.details.reason;
  }
}

export type WorkerLiveEventClientOptions = {
  runEpoch: number;
  initialAckedSeq?: number;
  maxBufferedEvents?: number;
};

type BufferedLiveEvent = {
  seq: number;
  runId: string;
  event: WorkerLiveEvent;
  resolve: (result: WorkerLiveEventResult) => void;
  reject: (error: Error) => void;
};

export class WorkerLiveEventClient {
  private readonly buffered: BufferedLiveEvent[] = [];
  private readonly unsubscribers: Array<() => void>;
  private ackedSeqValue: number;
  private nextSeqValue: number;
  private draining = false;
  private disposed = false;

  constructor(
    private readonly connection: WorkerConnection,
    private readonly options: WorkerLiveEventClientOptions,
  ) {
    this.ackedSeqValue = options.initialAckedSeq ?? 0;
    this.nextSeqValue = this.ackedSeqValue + 1;
    this.unsubscribers = [
      connection.onReady(() => this.scheduleDrain()),
      connection.onStateChange((state) => {
        if (state.kind === "fenced") {
          this.rejectAll(new WorkerFencedError(state.reason));
        } else if (state.kind === "failed") {
          this.rejectAll(state.error);
        } else if (state.kind === "stopped") {
          this.rejectAll(new WorkerConnectionStoppedError());
        }
      }),
    ];
  }

  get ackedSeq(): number {
    return this.ackedSeqValue;
  }

  get unackedCount(): number {
    return this.buffered.length;
  }

  emit(runId: string, event: WorkerLiveEvent): Promise<WorkerLiveEventResult> {
    if (this.disposed) {
      return Promise.reject(new Error("worker live-event client disposed"));
    }
    if (this.buffered.length >= (this.options.maxBufferedEvents ?? 1_024)) {
      return Promise.reject(new Error("worker live-event buffer capacity exceeded"));
    }
    return new Promise((resolve, reject) => {
      this.buffered.push({
        seq: this.nextSeqValue,
        runId,
        event: structuredClone(event),
        resolve,
        reject,
      });
      this.nextSeqValue += 1;
      this.scheduleDrain();
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.rejectAll(new Error("worker live-event client disposed"));
  }

  private scheduleDrain(): void {
    if (this.draining || this.disposed || this.buffered.length === 0) {
      return;
    }
    this.draining = true;
    void this.drain()
      .catch((error: unknown) => {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.draining = false;
        if (!this.disposed && this.buffered.length > 0) {
          this.scheduleDrain();
        }
      });
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.buffered.length > 0) {
      const current = this.buffered[0];
      if (!current) {
        return;
      }
      try {
        await this.connection.waitForReady();
        const response = await this.connection.requestLiveEvent({
          runEpoch: this.options.runEpoch,
          lastAckedSeq: this.ackedSeqValue,
          seq: current.seq,
          runId: current.runId,
          event: current.event,
        });
        if (response.ok) {
          if (
            response.payload.ackedSeq < this.ackedSeqValue ||
            response.payload.ackedSeq > current.seq
          ) {
            this.rejectAll(new Error("worker live-event acknowledgement is outside sent range"));
            return;
          }
          const previousAck = this.ackedSeqValue;
          this.ackThrough(response.payload.ackedSeq);
          if (this.ackedSeqValue === previousAck && this.buffered[0] === current) {
            this.rejectAll(new Error("worker live-event acknowledgement did not advance"));
            return;
          }
          continue;
        }
        if (response.error.details.reason === "resync-required") {
          if (response.error.details.ackedSeq > current.seq) {
            this.rejectAll(new Error("worker live-event resync acknowledged an unsent event"));
            return;
          }
          this.resync(response.error.details.ackedSeq, response.error.details.expectedSeq);
          continue;
        }
        fenceForOwnershipError(this.connection, response.error);
        this.rejectAll(new WorkerLiveEventError(response.error));
        return;
      } catch (error) {
        if (
          error instanceof WorkerConnectionInterruptedError &&
          !isTerminalConnection(this.connection)
        ) {
          return;
        }
        throw error;
      }
    }
  }

  private ackThrough(ackedSeq: number): void {
    this.ackedSeqValue = Math.max(this.ackedSeqValue, ackedSeq);
    while (true) {
      const entry = this.buffered[0];
      if (!entry || entry.seq > this.ackedSeqValue) {
        return;
      }
      this.buffered.shift();
      entry.resolve({ ackedSeq: this.ackedSeqValue });
    }
  }

  private resync(ackedSeq: number, expectedSeq: number): void {
    this.ackThrough(ackedSeq);
    const firstSeq = this.buffered[0]?.seq ?? this.nextSeqValue;
    if (firstSeq !== expectedSeq) {
      this.rejectAll(new Error("worker live-event replay window cannot satisfy resync"));
    }
  }

  private rejectAll(error: Error): void {
    const buffered = this.buffered.splice(0);
    for (const entry of buffered) {
      entry.reject(error);
    }
  }
}

export class WorkerInferenceProxyError extends Error {
  constructor(readonly response: InferenceResponseError) {
    super(response.message);
    this.name = "WorkerInferenceProxyError";
  }

  get reason(): InferenceResponseError["details"]["reason"] {
    return this.response.details.reason;
  }
}

export type WorkerInferenceHandlers = {
  onEvent?: (event: WorkerInferenceEventParams) => void;
  onStreamGap?: (gap: { expectedSeq: number; receivedSeq: number }) => void;
};

type InferenceOperation = {
  params: WorkerInferenceStartParams;
  handlers: WorkerInferenceHandlers;
  lastSeq: number;
  resumeRequested: boolean;
  startInFlight: boolean;
  settled: boolean;
  resolve: (outcome: WorkerInferenceTerminalOutcome) => void;
  reject: (error: Error) => void;
};

function inferenceKey(params: { sessionId: string; runId: string; turnId: string }): string {
  return `${params.sessionId}\u0000${params.runId}\u0000${params.turnId}`;
}

function matchesInferenceIdentity(
  operation: InferenceOperation,
  payload: WorkerInferenceEventParams | WorkerInferenceTerminalParams,
): boolean {
  return (
    payload.runEpoch === operation.params.runEpoch &&
    payload.sessionId === operation.params.sessionId &&
    payload.runId === operation.params.runId &&
    payload.turnId === operation.params.turnId
  );
}

export class WorkerInferenceProxyClient {
  private readonly operations = new Map<string, InferenceOperation>();
  private readonly unsubscribers: Array<() => void>;
  private disposed = false;

  constructor(private readonly connection: WorkerConnection) {
    this.unsubscribers = [
      connection.onReady(() => this.resume()),
      connection.onStateChange((state) => {
        if (state.kind === "fenced") {
          this.rejectAllOperations(new WorkerFencedError(state.reason));
        } else if (state.kind === "failed") {
          this.rejectAllOperations(state.error);
        } else if (state.kind === "stopped") {
          this.rejectAllOperations(new WorkerConnectionStoppedError());
        }
      }),
      connection.onInferenceEvent((frame) => this.handleEvent(frame.payload)),
      connection.onInferenceTerminal((frame) => this.handleTerminal(frame.payload)),
    ];
  }

  start(
    params: WorkerInferenceStartParams,
    handlers: WorkerInferenceHandlers = {},
  ): Promise<WorkerInferenceTerminalOutcome> {
    if (this.disposed) {
      return Promise.reject(new Error("worker inference client disposed"));
    }
    const snapshot = structuredClone(params);
    const key = inferenceKey(snapshot);
    if (this.operations.has(key)) {
      return Promise.reject(new Error("worker inference turn already active"));
    }
    return new Promise((resolve, reject) => {
      const operation: InferenceOperation = {
        params: snapshot,
        handlers,
        lastSeq: 0,
        resumeRequested: false,
        startInFlight: false,
        settled: false,
        resolve,
        reject,
      };
      this.operations.set(key, operation);
      this.scheduleStart(operation);
    });
  }

  async cancel(params: WorkerInferenceCancelParams): Promise<WorkerInferenceCancelResult> {
    const response = await this.connection.requestInferenceCancel(params);
    if (response.ok) {
      return response.payload;
    }
    fenceForOwnershipError(this.connection, response.error);
    throw new WorkerInferenceProxyError(response.error);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    for (const operation of this.operations.values()) {
      operation.settled = true;
      operation.reject(new Error("worker inference client disposed"));
    }
    this.operations.clear();
  }

  private resume(): void {
    for (const operation of this.operations.values()) {
      if (operation.startInFlight) {
        operation.resumeRequested = true;
        continue;
      }
      this.scheduleStart(operation);
    }
  }

  private scheduleStart(operation: InferenceOperation): void {
    if (operation.startInFlight || operation.settled || this.disposed) {
      return;
    }
    operation.startInFlight = true;
    void this.issueStart(operation);
  }

  private async issueStart(operation: InferenceOperation): Promise<void> {
    let interrupted = false;
    try {
      await this.connection.waitForReady();
      const response = await this.connection.requestInferenceStart(operation.params, (frame) => {
        if (frame.ok && frame.payload.status === "replayed") {
          operation.lastSeq = 0;
        }
      });
      if (!response.ok) {
        fenceForOwnershipError(this.connection, response.error);
        this.rejectOperation(operation, new WorkerInferenceProxyError(response.error));
        return;
      }
      operation.resumeRequested = false;
    } catch (error) {
      if (error instanceof WorkerConnectionInterruptedError) {
        interrupted = true;
      } else {
        this.rejectOperation(operation, error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      operation.startInFlight = false;
      if (interrupted && operation.resumeRequested && !operation.settled) {
        operation.resumeRequested = false;
        this.scheduleStart(operation);
      }
    }
  }

  private handleEvent(payload: WorkerInferenceEventParams): void {
    const operation = this.operations.get(inferenceKey(payload));
    if (!operation || operation.settled || !matchesInferenceIdentity(operation, payload)) {
      return;
    }
    this.applyEvent(operation, payload);
  }

  private applyEvent(operation: InferenceOperation, payload: WorkerInferenceEventParams): void {
    if (payload.seq <= operation.lastSeq) {
      return;
    }
    if (payload.seq !== operation.lastSeq + 1) {
      try {
        operation.handlers.onStreamGap?.({
          expectedSeq: operation.lastSeq + 1,
          receivedSeq: payload.seq,
        });
      } catch (error) {
        this.rejectOperation(operation, error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    operation.lastSeq = payload.seq;
    try {
      operation.handlers.onEvent?.(payload);
    } catch (error) {
      this.rejectOperation(operation, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleTerminal(payload: WorkerInferenceTerminalParams): void {
    const operation = this.operations.get(inferenceKey(payload));
    if (!operation || operation.settled || !matchesInferenceIdentity(operation, payload)) {
      return;
    }
    this.applyTerminal(operation, payload);
  }

  private applyTerminal(
    operation: InferenceOperation,
    payload: WorkerInferenceTerminalParams,
  ): void {
    if (payload.seq <= operation.lastSeq) {
      return;
    }
    if (payload.seq !== operation.lastSeq + 1) {
      try {
        operation.handlers.onStreamGap?.({
          expectedSeq: operation.lastSeq + 1,
          receivedSeq: payload.seq,
        });
      } catch (error) {
        this.rejectOperation(operation, error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    operation.lastSeq = payload.seq;
    operation.settled = true;
    this.operations.delete(inferenceKey(operation.params));
    operation.resolve(payload.outcome);
  }

  private rejectOperation(operation: InferenceOperation, error: Error): void {
    if (operation.settled) {
      return;
    }
    operation.settled = true;
    this.operations.delete(inferenceKey(operation.params));
    operation.reject(error);
  }

  private rejectAllOperations(error: Error): void {
    for (const operation of this.operations.values()) {
      this.rejectOperation(operation, error);
    }
  }
}
