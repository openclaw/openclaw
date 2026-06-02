import type { OutputItem } from "./open-responses.schema.js";

/** Builds a Responses API assistant message output item. */
export function createAssistantOutputItem(params: {
  /** Stable output item id emitted to the Responses client. */
  id: string;
  /** Assistant text payload for this output item. */
  text: string;
  /** Optional OpenClaw phase annotation used by compatible streaming clients. */
  phase?: "commentary" | "final_answer";
  /** Optional lifecycle status for in-progress versus completed output. */
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

/** Builds a Responses API function_call output item from a structured client-tool call. */
export function createFunctionCallOutputItem(params: {
  /** Stable output item id emitted to the Responses client. */
  id: string;
  /** Provider/tool call id that links call and output records. */
  callId: string;
  /** Client-visible tool/function name. */
  name: string;
  /** JSON argument string supplied for the client tool call. */
  arguments: string;
  /** Optional lifecycle status for in-progress versus completed calls. */
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
