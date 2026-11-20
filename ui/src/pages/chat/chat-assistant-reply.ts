import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isLegacyCodexProviderId } from "../../../../src/config/legacy-codex-provider.js";
import {
  extractAssistantTextForPhase,
  resolveAssistantMessagePhase,
} from "../../../../src/shared/chat-message-content.js";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { isKeyedAssistantStreamFallbackMessage } from "./chat-thread-run-identity.ts";
import { extractMessageMediaText } from "./components/chat-message-media.ts";
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
    phase === "commentary" ||
    stopReason === "toolUse" ||
    stopReason === "error" ||
    (metadata?.mirrorOrigin === "codex-app-server" && metadata.runTerminal !== true)
  ) {
    return false;
  }
  return !explicitOnly || phase === "final_answer" || stopReason === "stop";
}

// The saved response identifies the author, not the current model picker or an
// OpenAI-compatible API. Native imports may record only the upstream provider.
export function isRecordedOpenAIModel(record: Record<string, unknown>): boolean {
  const model = normalizeLowercaseStringOrEmpty(record.model);
  const provider = normalizeLowercaseStringOrEmpty(record.provider);
  if (!provider || !model) {
    return false;
  }
  const served = normalizeLowercaseStringOrEmpty(record.responseModel);
  const direct = provider === "openai" || isLegacyCodexProviderId(provider);
  const upstream = (id: string) =>
    parseProviderModelRef(
      !direct && id.startsWith(provider + "/") ? id.slice(provider.length + 1) : id,
    );
  const requested = upstream(model);
  const actual = upstream(served);
  if (actual) {
    return actual.provider === "openai";
  }
  if (direct) {
    return !requested || requested.provider === "openai";
  }
  // An unrelated bare response ID cannot confirm the requested upstream vendor.
  return (
    requested?.provider === "openai" &&
    (!served ||
      served === requested.model ||
      served.replace(/-\d{4}-\d{2}-\d{2}$/, "") === requested.model)
  );
}
