import { toOpenAiResponsesUsage } from "../agents/usage.js";
import type { OutputItem, ResponseResource, Usage } from "./open-responses.schema.js";

export function createAssistantOutputItem(params: {
  id: string;
  text: string;
  phase?: "commentary" | "final_answer";
  status?: "in_progress" | "completed" | "incomplete";
}): Extract<OutputItem, { type: "message" }> {
  return {
    type: "message",
    id: params.id,
    role: "assistant",
    content: [{ type: "output_text", text: params.text }],
    ...(params.phase ? { phase: params.phase } : {}),
    status: params.status,
  };
}

export function createFunctionCallOutputItem(params: {
  id: string;
  callId: string;
  name: string;
  arguments: string;
  status?: "in_progress" | "completed";
}): Extract<OutputItem, { type: "function_call" }> {
  return {
    type: "function_call",
    id: params.id,
    call_id: params.callId,
    name: params.name,
    arguments: params.arguments,
    status: params.status,
  };
}

export function createResponseResource(params: {
  id: string;
  createdAt: number;
  model: string;
  status: ResponseResource["status"];
  output: OutputItem[];
  usage?: Usage;
  error?: { code: string; message: string };
}): ResponseResource {
  return {
    id: params.id,
    object: "response",
    created_at: params.createdAt,
    status: params.status,
    model: params.model,
    output: params.output,
    usage: params.usage ?? toOpenAiResponsesUsage(undefined),
    error: params.error,
    ...(params.status === "incomplete"
      ? { incomplete_details: { reason: "max_output_tokens" as const } }
      : {}),
  };
}
