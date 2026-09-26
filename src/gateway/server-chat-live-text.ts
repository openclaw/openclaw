import type { ChatEvent } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { AgentEventPayload } from "../infra/agent-events.js";

export function mergeAgentTextPayload(previous: unknown, next: unknown): AgentEventPayload {
  // SAFETY: this callback only merges the same typed agent producer and stream/item key.
  const payload = next as AgentEventPayload;
  // SAFETY: the coalescing key prevents mixing agent payloads with other event shapes.
  const delta = (previous as AgentEventPayload).data.delta;
  const nextDelta = payload.data.delta;
  return payload.stream !== "item" && typeof delta === "string" && typeof nextDelta === "string"
    ? { ...payload, data: { ...payload.data, delta: `${delta}${nextDelta}` } }
    : payload;
}

export function mergeChatTextPayload(previous: unknown, next: unknown): ChatEvent {
  type Delta = Extract<ChatEvent, { state: "delta" }>;
  // SAFETY: only append deltas use this callback; replacements and terminal events flush it.
  const payload = next as Delta;
  // SAFETY: both values share the same chat-delta delivery key and buffering generation.
  return { ...payload, deltaText: `${(previous as Delta).deltaText}${payload.deltaText}` };
}
