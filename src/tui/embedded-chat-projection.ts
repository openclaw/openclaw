import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";

const TUI_STATE_BY_TERMINAL_CLASSIFICATION = {
  success: undefined,
  timeout: "error",
  cancellation: "aborted",
  failure: "error",
} as const;

export function resolveTerminalChatState(outcome: AgentRunTerminalOutcome) {
  return TUI_STATE_BY_TERMINAL_CLASSIFICATION[classifyAgentRunTerminalOutcome(outcome)];
}

export function assistantChatMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
}

export function payloadText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => {
      const payload = asOptionalObjectRecord(part);
      return typeof payload?.text === "string" ? payload.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function resolveDeltaPayload(text: string, previousText: string | undefined) {
  if (previousText === undefined) {
    return { deltaText: text };
  }
  if (!text.startsWith(previousText)) {
    return { deltaText: text, replace: true as const };
  }
  return { deltaText: text.slice(previousText.length) };
}
