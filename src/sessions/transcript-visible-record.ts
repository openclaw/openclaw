import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../agents/internal-runtime-context.js";
import { extractStoredAssistantText } from "../agents/tools/chat-history-text.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "./transcript-events.js";

export function isVisibleTranscriptRecord(value: unknown): value is Record<string, unknown> {
  const record = asOptionalRecord(value);
  return (
    Boolean(record?.message) ||
    record?.type === "compaction" ||
    record?.type === "reset" ||
    (record?.type === "custom_message" &&
      record.display === true &&
      record.customType !== OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE)
  );
}

export function isVisibleAssistantResultEventForRun(event: unknown, runId: string): boolean {
  if (
    !isRecord(event) ||
    !isRecord(event.message) ||
    readSessionTranscriptRunId(event.message) !== runId ||
    resolveTerminalAssistantTranscriptRunId(event.message, runId) === undefined
  ) {
    return false;
  }
  const mirror = event.message.openclawDeliveryMirror;
  if (isRecord(mirror) && mirror.kind === "message-tool-source-reply" && mirror.final !== true) {
    return false;
  }
  // A final source reply remains visible when the run ends with NO_REPLY.
  const text = extractStoredAssistantText(event.message);
  return Boolean(text?.trim()) && !isSilentReplyText(text, SILENT_REPLY_TOKEN);
}

export type SessionTranscriptEventMatch =
  | { kind: "latest" }
  | { kind: "visible-final"; runId: string }
  | {
      kind: "idempotency";
      key: string;
      assistant?: boolean;
      runId?: string;
      deliveryMirror?: boolean;
    }
  | { kind: "active-assistant"; runId: string };

/** Match content before checking any active-branch identity in the same snapshot. */
export function matchesTranscriptEvent(
  event: unknown,
  match: SessionTranscriptEventMatch,
): boolean {
  if (match.kind === "latest") {
    return true;
  }
  if (match.kind === "visible-final") {
    return isVisibleAssistantResultEventForRun(event, match.runId);
  }
  const message = asOptionalRecord(asOptionalRecord(event)?.message);
  if (match.kind === "idempotency") {
    return (
      message?.idempotencyKey === match.key &&
      (!match.assistant || message.role === "assistant") &&
      (match.runId === undefined || readSessionTranscriptRunId(message) === match.runId) &&
      (!match.deliveryMirror || isOpenClawDeliveryMirrorAssistantMessage(message))
    );
  }
  return message?.role === "assistant" && readSessionTranscriptRunId(message) === match.runId;
}
