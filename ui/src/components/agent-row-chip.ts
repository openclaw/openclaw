import { html } from "lit";
import "./agent-row-chip.tsx";

export function renderAgentRowChip(agentId?: string) {
  return html`<openclaw-agent-row-chip .agentId=${agentId}></openclaw-agent-row-chip>`;
}
