import type { AgentEventPayload } from "../infra/agent-events.js";

/** Extracts streamable assistant text, preferring incremental deltas over full snapshots. */
export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string {
  const delta = evt.data.delta;
  const text = evt.data.text;
  return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}
