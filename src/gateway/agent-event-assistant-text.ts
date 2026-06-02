import type { AgentEventPayload } from "../infra/agent-events.js";

/**
 * Extract assistant stream text from provider event variants.
 *
 * Streaming adapters disagree on whether incremental text is carried as
 * `delta` or `text`; gateway HTTP responders need one normalized string.
 */
export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string {
  const delta = evt.data.delta;
  const text = evt.data.text;
  return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}
