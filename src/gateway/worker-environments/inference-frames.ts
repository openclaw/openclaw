import {
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  type WorkerInferenceErrorReason,
  type WorkerInferenceEventFrame,
  type WorkerInferenceStartParams,
  type WorkerInferenceTerminalFrame,
  type WorkerInferenceTerminalOutcome,
  validateWorkerInferenceTerminalFrame,
  validateWorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";

type WorkerInferenceFrameContext = {
  request: Pick<WorkerInferenceStartParams, "runEpoch" | "sessionId" | "runId" | "turnId">;
  seq: number;
};

export function terminalError(
  reason: WorkerInferenceErrorReason,
  outcome?: WorkerInferenceTerminalOutcome,
  errorMessage?: string,
): WorkerInferenceTerminalOutcome {
  const usage =
    outcome?.type === "done"
      ? outcome.message.usage
      : outcome?.type === "error"
        ? outcome.usage
        : undefined;
  const message = (() => {
    switch (reason) {
      case "model-not-approved":
        return "Model is not approved";
      case "invalid-context":
        return "Inference context is invalid";
      case "epoch-mismatch":
        return "Inference ownership changed";
      case "session-not-attached":
        return "Session is not attached";
      case "provider-error":
        return "Provider request failed";
      case "cancelled":
        return "Inference cancelled";
    }
    return "Provider request failed";
  })();
  return {
    type: "error",
    reason,
    message: errorMessage ?? message,
    ...(usage ? { usage } : {}),
  };
}

export function validFrameBytes(
  frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame,
  validate: (data: unknown) => boolean,
): number | null {
  const measured = boundedJsonUtf8Bytes(frame, WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES);
  if (
    measured.complete &&
    measured.bytes <= WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES &&
    validate(frame)
  ) {
    return measured.bytes;
  }
  return null;
}

export function terminalFrame(
  entry: WorkerInferenceFrameContext,
  outcome: WorkerInferenceTerminalOutcome,
  seq = entry.seq + 1,
): WorkerInferenceTerminalFrame {
  return {
    type: "event",
    event: "worker.inference.terminal",
    payload: {
      runEpoch: entry.request.runEpoch,
      sessionId: entry.request.sessionId,
      runId: entry.request.runId,
      turnId: entry.request.turnId,
      seq,
      outcome,
    },
  };
}

export function normalizeTerminalOutcome(
  entry: WorkerInferenceFrameContext,
  outcome: WorkerInferenceTerminalOutcome,
): WorkerInferenceTerminalOutcome {
  if (
    !validateWorkerInferenceTerminalOutcome(outcome) ||
    validFrameBytes(terminalFrame(entry, outcome), validateWorkerInferenceTerminalFrame) === null
  ) {
    return terminalError("provider-error");
  }
  return outcome;
}
