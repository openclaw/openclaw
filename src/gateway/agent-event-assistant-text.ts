import type { AgentEventPayload } from "../infra/agent-events.js";

/** Resolve assistant text from an agent event, preferring deltas for streaming clients. */
export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string {
  const delta = evt.data.delta;
  const text = evt.data.text;
  return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}
