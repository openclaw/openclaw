import { copyInternalToolResultState } from "../../../packages/agent-core/src/internal-hooks.js";
import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  const result = { content: [{ type: "text" as const, text }], details };
  return details && typeof details === "object"
    ? copyInternalToolResultState(details, result)
    : result;
}

export function jsonResult<TDetails>(payload: TDetails): AgentToolResult<TDetails> {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

export function failText(text: string): AgentToolResult<unknown> {
  return textResult(text, { status: "failed", error: text });
}
