import { randomUUID } from "node:crypto";
import { toStructuredErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { WebSocket } from "ws";
import {
  type WorkerConnectParams,
  type WorkerHeartbeatParams,
  WorkerHeartbeatResponseFrameSchema,
  type WorkerLiveEventParams,
  WorkerLiveEventResponseFrameSchema,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  type WorkerTranscriptCommitParams,
  WorkerTranscriptCommitResponseFrameSchema,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  type WorkerComputerParams,
  WorkerComputerResponseFrameSchema,
} from "../../packages/gateway-protocol/src/schema/worker-computer.js";
import {
  type WorkerGatewayToolInvokeParams,
  type WorkerGatewayToolCancelParams,
  type WorkerGatewayToolUpdateFrame,
  WorkerGatewayToolResponseFrameSchema,
  WorkerGatewayToolCancelResponseFrameSchema,
  WORKER_GATEWAY_TOOL_METHODS,
  isWorkerGatewayToolFrameWithinBudget,
  validateWorkerGatewayToolUpdateFrame,
} from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import {
  type WorkerInferenceCancelParams,
  WorkerInferenceCancelResponseFrameSchema,
  type WorkerInferenceEventFrame,
  type WorkerInferenceStartParams,
  WorkerInferenceStartResponseFrameSchema,
  type WorkerInferenceTerminalFrame,
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  validateWorkerInferenceEventFrame,
  validateWorkerInferenceTerminalFrame,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { isWorkerTranscriptFrameWithinBudget } from "../../packages/gateway-protocol/src/worker-transcript-budget.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import {
  createPendingRequestRegistry,
  type PendingRequestEntry,
} from "../shared/pending-request-registry.js";
import { WorkerConnectionInterruptedError } from "./worker-connection-contract.js";

const WORKER_REQUEST_SPECS = {
  "gateway-tool": {
    method: WORKER_GATEWAY_TOOL_METHODS.invoke,
    responseSchema: WorkerGatewayToolResponseFrameSchema,
  },
  "gateway-tool-cancel": {
    method: WORKER_GATEWAY_TOOL_METHODS.cancel,
    responseSchema: WorkerGatewayToolCancelResponseFrameSchema,
  },
  heartbeat: {
    method: "worker.heartbeat",
    responseSchema: WorkerHeartbeatResponseFrameSchema,
  },
  transcript: {
    method: "worker.transcript.commit",
    responseSchema: WorkerTranscriptCommitResponseFrameSchema,
  },
  "live-event": {
    method: "worker.live-event",
    responseSchema: WorkerLiveEventResponseFrameSchema,
  },
  computer: {
    method: "worker.computer",
    responseSchema: WorkerComputerResponseFrameSchema,
  },
  "inference-start": {
    method: "worker.inference.start",
    responseSchema: WorkerInferenceStartResponseFrameSchema,
  },
  "inference-cancel": {
    method: "worker.inference.cancel",
    responseSchema: WorkerInferenceCancelResponseFrameSchema,
  },
} as const;

type WorkerRequestKind = keyof typeof WORKER_REQUEST_SPECS;
type WorkerRequestParams = {
  "gateway-tool": WorkerGatewayToolInvokeParams;
  "gateway-tool-cancel": WorkerGatewayToolCancelParams;
  heartbeat: WorkerHeartbeatParams;
  transcript: WorkerTranscriptCommitParams;
  "live-event": WorkerLiveEventParams;
  computer: WorkerComputerParams;
  "inference-start": WorkerInferenceStartParams;
  "inference-cancel": WorkerInferenceCancelParams;
};
type WorkerResponseFrames = {
  [K in WorkerRequestKind]: Static<(typeof WORKER_REQUEST_SPECS)[K]["responseSchema"]>;
};
type WorkerResponseFrame = WorkerResponseFrames[WorkerRequestKind];
type PendingRequestValue = {
  kind: WorkerRequestKind;
  timeoutMs?: number;
  // Durable replay can emit its terminal as the next socket frame. Reset the
  // consumer cursor synchronously after validation, before Promise continuation.
  beforeResolve?: (frame: WorkerResponseFrame) => void;
};
type PendingRequest = PendingRequestEntry<WorkerResponseFrame, PendingRequestValue>;

type WorkerConnectionFrameDispatcherOptions = {
  connectParams: () => WorkerConnectParams;
  requestTimeoutMs: number;
  isReady: () => boolean;
  socket: () => WebSocket | undefined;
  isTerminal: () => boolean;
  terminalError: () => Error;
  interruptReadySocket: (socket: WebSocket) => void;
};

function responseId(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object") {
    return undefined;
  }
  const candidate = frame as { id?: unknown; type?: unknown };
  return candidate.type === "res" && typeof candidate.id === "string" ? candidate.id : undefined;
}

export function closeInvalidWorkerFrame(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1008, "invalid-frame");
  }
}

export class WorkerConnectionFrameDispatcher {
  private readonly pending = createPendingRequestRegistry<
    string,
    WorkerResponseFrame,
    PendingRequestValue
  >();
  private readonly gatewayToolUpdateListeners = new Set<
    (frame: WorkerGatewayToolUpdateFrame) => void
  >();
  private readonly inferenceEventListeners = new Set<(frame: WorkerInferenceEventFrame) => void>();
  private readonly inferenceTerminalListeners = new Set<
    (frame: WorkerInferenceTerminalFrame) => void
  >();

  constructor(private readonly options: WorkerConnectionFrameDispatcherOptions) {}

  onGatewayToolUpdate(listener: (frame: WorkerGatewayToolUpdateFrame) => void): () => void {
    return registerListener(this.gatewayToolUpdateListeners, listener);
  }

  onInferenceEvent(listener: (frame: WorkerInferenceEventFrame) => void): () => void {
    return registerListener(this.inferenceEventListeners, listener);
  }

  onInferenceTerminal(listener: (frame: WorkerInferenceTerminalFrame) => void): () => void {
    return registerListener(this.inferenceTerminalListeners, listener);
  }

  dispatchReadyFrame(frame: unknown, socket: WebSocket): void {
    if (validateWorkerGatewayToolUpdateFrame(frame)) {
      if (!isWorkerGatewayToolFrameWithinBudget(frame, frame.payload.result)) {
        closeInvalidWorkerFrame(socket);
        return;
      }
      notifyListeners(this.gatewayToolUpdateListeners, frame);
      return;
    }
    if (validateWorkerInferenceEventFrame(frame)) {
      if (!this.matchesInferenceIdentity(frame.payload)) {
        closeInvalidWorkerFrame(socket);
        return;
      }
      notifyListeners(this.inferenceEventListeners, frame);
      return;
    }
    if (validateWorkerInferenceTerminalFrame(frame)) {
      if (!this.matchesInferenceIdentity(frame.payload)) {
        closeInvalidWorkerFrame(socket);
        return;
      }
      notifyListeners(this.inferenceTerminalListeners, frame);
      return;
    }
    const id = responseId(frame);
    const pending = id ? this.pending.get(id) : undefined;
    if (!id || !pending) {
      closeInvalidWorkerFrame(socket);
      return;
    }
    if (!this.resolvePendingFrame(id, pending, frame)) {
      closeInvalidWorkerFrame(socket);
    }
  }

  rejectPending(error: Error): void {
    this.pending.rejectAll(error);
  }

  private matchesInferenceIdentity(payload: { runEpoch: number; sessionId: string }): boolean {
    const admission = this.options.connectParams().admission;
    return payload.runEpoch === admission.ownerEpoch && payload.sessionId === admission.sessionId;
  }

  request<K extends WorkerRequestKind>(
    kind: K,
    params: WorkerRequestParams[K],
    beforeResolve?: (frame: WorkerResponseFrames[K]) => void,
    timeoutMs?: number,
  ): Promise<WorkerResponseFrames[K]> {
    const id = randomUUID();
    const spec = WORKER_REQUEST_SPECS[kind];
    const frame = { type: "req", id, method: spec.method, params };
    if (
      kind === "transcript" &&
      !isWorkerTranscriptFrameWithinBudget({
        type: "req",
        id,
        method: "worker.transcript.commit",
        // SAFETY: The generic request kind selects its matching WorkerRequestParams member.
        params: params as WorkerTranscriptCommitParams,
      })
    ) {
      return Promise.reject(new Error("worker transcript exceeds the protocol payload limit"));
    }
    const wrappedBeforeResolve = beforeResolve
      ? (response: WorkerResponseFrame) => beforeResolve(response as WorkerResponseFrames[K])
      : undefined;
    return this.sendRequest(id, frame, {
      kind,
      ...(wrappedBeforeResolve ? { beforeResolve: wrappedBeforeResolve } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }) as Promise<WorkerResponseFrames[K]>;
  }

  private resolvePendingFrame(id: string, pending: PendingRequest, frame: unknown): boolean {
    const spec = WORKER_REQUEST_SPECS[pending.value.kind];
    if (!Value.Check(spec.responseSchema, frame)) {
      return false;
    }
    if (
      (pending.value.kind === "gateway-tool" || pending.value.kind === "gateway-tool-cancel") &&
      !isWorkerGatewayToolFrameWithinBudget(
        frame,
        Value.Check(WorkerGatewayToolResponseFrameSchema, frame) && frame.ok
          ? frame.payload
          : undefined,
      )
    ) {
      return false;
    }
    const completed = this.pending.take(id, pending);
    if (!completed) {
      return false;
    }
    try {
      completed.value.beforeResolve?.(frame);
    } catch (error) {
      completed.reject(toStructuredErrorObject(error));
      return true;
    }
    completed.resolve(frame);
    return true;
  }

  private sendRequest(
    id: string,
    frame: object,
    value: PendingRequestValue,
  ): Promise<WorkerResponseFrame> {
    const ready = this.options.isReady();
    const readySocket = ready ? this.options.socket() : undefined;
    if (!ready || !readySocket || readySocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        this.options.isTerminal()
          ? this.options.terminalError()
          : new WorkerConnectionInterruptedError("worker connection is not ready"),
      );
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(frame);
    } catch (error) {
      return Promise.reject(toStructuredErrorObject(error));
    }
    const payloadLimit =
      value.kind === "inference-start" || value.kind === "transcript"
        ? WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES
        : WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
    if (Buffer.byteLength(encoded, "utf8") > payloadLimit) {
      return Promise.reject(new Error("worker request exceeds the protocol payload limit"));
    }
    const pending = this.pending.add(id, {
      value,
      timeoutMs: value.timeoutMs ?? this.options.requestTimeoutMs,
      timeoutError: () =>
        new WorkerConnectionInterruptedError(`worker ${value.kind} response timed out`),
      onTimeout: () => this.options.interruptReadySocket(readySocket),
    });
    if (!pending) {
      return Promise.reject(new Error("worker request id collision"));
    }
    try {
      readySocket.send(encoded, (error) => {
        if (!error) {
          return;
        }
        const failed = this.pending.take(id, pending);
        if (!failed) {
          return;
        }
        failed.reject(new WorkerConnectionInterruptedError(error.message));
        this.options.interruptReadySocket(readySocket);
      });
    } catch (error) {
      this.pending
        .take(id, pending)
        ?.reject(new WorkerConnectionInterruptedError(toStructuredErrorObject(error).message));
      this.options.interruptReadySocket(readySocket);
    }
    return pending.promise;
  }
}
