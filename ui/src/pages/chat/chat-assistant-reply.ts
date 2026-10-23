import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  extractAssistantTextForPhase,
  resolveAssistantMessagePhase,
} from "../../../../src/shared/chat-message-content.js";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { isKeyedAssistantStreamFallbackMessage } from "./chat-thread-run-identity.ts";
import { assistantGroupIsIndependentBoundary } from "./chat-turn-boundary.ts";
import { extractMessageMediaText } from "./components/chat-message-media.ts";
import { readLiveTerminalDisposition } from "./terminal-message-identity.ts";

/** Host-stamped provider speech is a call transcript, not a backing-agent answer. */
export function isProviderVoiceTranscript(message: unknown): boolean {
  const record = asRecord(message);
  return (
    record?.role === "assistant" &&
    asRecord(record["__openclaw"])?.voiceTranscript === "provider-owned"
  );
}

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

/**
 * Whether an assistant message can answer its turn and so own reply/copy actions.
 * Progress text written before a tool call (commentary, or any provider's
 * `toolUse` stop) never can, whether or not the provider labels its phase.
 * `explicitOnly` additionally requires an explicit answer phase or `stop`.
 */
export function assistantMessageCanOwnTurnActions(message: unknown, explicitOnly = false): boolean {
  const record = asRecord(message);
  const phase = resolveAssistantReplyPhase(message);
  const stopReason = record?.stopReason;
  const metadata = asRecord(record?.["__openclaw"]);
  if (
    !(extractTextCached(message)?.trim() || extractMessageMediaText(message)) ||
    assistantMessageIsInterrupted(message) ||
    isProviderVoiceTranscript(message) ||
    phase === "commentary" ||
    stopReason === "toolUse" ||
    stopReason === "error" ||
    (metadata?.mirrorOrigin === "codex-app-server" && metadata.runTerminal !== true)
  ) {
    return false;
  }
  return !explicitOnly || phase === "final_answer" || stopReason === "stop";
}

export function assistantMessageKind(
  message: unknown,
  visibleContent: MessageGroup["visibleContent"],
) {
  if (isProviderVoiceTranscript(message)) {
    return "voice-transcript";
  }
  return (
    resolveAssistantReplyPhase(message) ??
    (asRecord(message)?.stopReason === "toolUse"
      ? "commentary"
      : visibleContent === "none"
        ? "activity"
        : "reply")
  );
}

/** A group holding the message that ended its run in failure; it marks where the run stopped. */
export function groupEndsRunInFailure(group: MessageGroup): boolean {
  return group.messages.some(
    ({ message }) =>
      assistantMessageIsInterrupted(message) || asRecord(message)?.stopReason === "error",
  );
}

export function assistantGroupCanOwnActiveRunStatus(group: MessageGroup): boolean {
  return (
    group.role.toLowerCase() === "assistant" &&
    !assistantGroupIsIndependentBoundary(group) &&
    !group.messages.some(({ message }) => isProviderVoiceTranscript(message)) &&
    (group.visibleContent === "text" || group.visibleContent === "non-text")
  );
}
