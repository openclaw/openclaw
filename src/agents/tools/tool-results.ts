import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function jsonResult<TDetails>(payload: TDetails): AgentToolResult<TDetails> {
  return textResult(JSON.stringify(payload), payload);
}

function stringifyToolPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  try {
    const encoded = JSON.stringify(payload);
    if (typeof encoded === "string") {
      return encoded;
    }
  } catch {
    // Fall through to String(payload) for non-serializable values.
  }
  return String(payload);
}

export function payloadTextResult<TDetails>(payload: TDetails): AgentToolResult<TDetails> {
  return textResult(stringifyToolPayload(payload), payload);
}

export function failText(text: string): AgentToolResult<unknown> {
  return textResult(text, { status: "failed", error: text });
}
