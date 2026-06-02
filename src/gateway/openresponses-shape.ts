import type { OutputItem } from "./open-responses.schema.js";

/** Build an assistant message item in the OpenAI Responses output shape. */
export function createAssistantOutputItem(params: {
  id: string;
  text: string;
  phase?: "commentary" | "final_answer";
  status?: "in_progress" | "completed";
}): OutputItem {
  return {
    type: "message",
    id: params.id,
    role: "assistant",
    content: [{ type: "output_text", text: params.text }],
    ...(params.phase ? { phase: params.phase } : {}),
    status: params.status,
  };
}

/**
 * Build a function_call output item while preserving the exact serialized
 * arguments string expected by Responses clients and stream deltas.
 */
export function createFunctionCallOutputItem(params: {
  id: string;
  callId: string;
  name: string;
  arguments: string;
  status?: "in_progress" | "completed";
}): OutputItem {
  return {
    type: "function_call",
    id: params.id,
    call_id: params.callId,
    name: params.name,
    arguments: params.arguments,
    status: params.status,
  };
}
