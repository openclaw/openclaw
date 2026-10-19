import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isTranscriptArtifactProvider } from "../../packages/agent-core/src/harness/session/transcript-model.js";
import { projectSessionDisplayMessage } from "../gateway/session-display-projection.js";
import { readSessionTranscriptRunId } from "./transcript-events.js";

export type SessionTranscriptTerminalModel = {
  runId: string;
  modelProvider: string;
  model: string;
};

/** Retain transcript facts independently of the current row's selected model and run. */
export function readSessionTranscriptTerminalModel(
  event: unknown,
): SessionTranscriptTerminalModel | null {
  const message = asOptionalRecord(asOptionalRecord(event)?.message);
  const runId = readSessionTranscriptRunId(message);
  return message &&
    runId &&
    (message.stopReason === "stop" || message.stopReason === "length") &&
    message.display !== false &&
    projectSessionDisplayMessage(message, { view: "model-context" })?.role === "assistant" &&
    typeof message.provider === "string" &&
    !isTranscriptArtifactProvider(message.provider) &&
    typeof message.model === "string"
    ? { runId, modelProvider: message.provider, model: message.model }
    : null;
}

export function isSessionTranscriptTerminalModel(
  value: unknown,
): value is SessionTranscriptTerminalModel {
  const model = asOptionalRecord(value);
  return Boolean(
    model &&
    typeof model.runId === "string" &&
    typeof model.modelProvider === "string" &&
    !isTranscriptArtifactProvider(model.modelProvider) &&
    typeof model.model === "string",
  );
}
