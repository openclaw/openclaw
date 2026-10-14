import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  extractAssistantTextForPhase,
  resolveAssistantMessagePhase,
} from "../../../../src/shared/chat-message-content.js";
import { isKeyedAssistantStreamFallbackMessage } from "./chat-thread-run-identity.ts";
import { readLiveTerminalDisposition } from "./terminal-message-identity.ts";

export function assistantMessageIsInterrupted(message: unknown): boolean {
  const record = asRecord(message);
  const stopReason = typeof record?.stopReason === "string" ? record.stopReason.toLowerCase() : "";
  return (
    readLiveTerminalDisposition(message) !== null ||
    asRecord(record?.openclawAbort)?.aborted === true ||
    ["aborted", "cancelled", "canceled", "timeout", "timed_out"].includes(stopReason)
  );
}

/** Presentation uses terminal ownership when the harness omits an optional message phase. */
export function resolveAssistantReplyPhase(message: unknown) {
  if (isKeyedAssistantStreamFallbackMessage(message)) {
    return "commentary";
  }
  // Mixed-phase messages retain any explicit answer, including its media.
  if (extractAssistantTextForPhase(message, { phase: "final_answer" })) {
    return "final_answer";
  }
  const phase = resolveAssistantMessagePhase(message);
  if (phase) {
    return phase;
  }
  const record = asRecord(message);
  const metadata = asRecord(record?.["__openclaw"]);
  return metadata?.mirrorOrigin === "codex-app-server" &&
    metadata.runTerminal === true &&
    record?.stopReason === "stop" &&
    !assistantMessageIsInterrupted(message)
    ? "final_answer"
    : undefined;
}
