import {
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  type WorkerInferenceErrorReason,
  type WorkerInferenceEventFrame,
  type WorkerInferenceStartParams,
  type WorkerInferenceTerminalFrame,
  type WorkerInferenceTerminalOutcome,
  validateWorkerInferenceTerminalFrame,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";

type WorkerInferenceFrameContext = {
  request: Pick<WorkerInferenceStartParams, "runEpoch" | "sessionId" | "runId" | "turnId">;
  seq: number;
};

const TERMINAL_ERROR_MESSAGES: Record<WorkerInferenceErrorReason, string> = {
  "model-not-approved": "Model is not approved",
  "invalid-context": "Inference context is invalid",
  "epoch-mismatch": "Inference ownership changed",
  "session-not-attached": "Session is not attached",
  "provider-error": "Provider request failed",
  cancelled: "Inference cancelled",
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
  return {
    type: "error",
    reason,
    message: errorMessage ?? TERMINAL_ERROR_MESSAGES[reason],
    ...(usage ? { usage } : {}),
  };
}

export function validFrameBytes(
  frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame,
  validate: (data: unknown) => boolean,
): number | null {
  const measured = boundedJsonUtf8Bytes(frame, WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES);
  if (measured.complete && validate(frame)) {
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
    validFrameBytes(terminalFrame(entry, outcome), validateWorkerInferenceTerminalFrame) === null
  ) {
    return terminalError("provider-error");
  }
  return outcome;
}
