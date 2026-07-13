import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { NewSessionRouteData } from "./location.ts";

export function routeKey(data?: NewSessionRouteData): string {
  return JSON.stringify([data?.agentId ?? "", data?.model ?? "", data?.catalogLabel ?? ""]);
}

export function agentId(data?: NewSessionRouteData): string {
  return data?.model && data.catalogLabel ? normalizeAgentId(data.agentId) : "";
}

export function resolveAgentId(
  data: NewSessionRouteData | undefined,
  availableAgents: readonly { id: string }[],
  fallback: string,
): string {
  const catalogAgentId = agentId(data);
  if (catalogAgentId) {
    return catalogAgentId;
  }
  const requested = normalizeAgentId(data?.agentId ?? "");
  return availableAgents.some((candidate) => normalizeAgentId(candidate.id) === requested)
    ? requested
    : normalizeAgentId(fallback);
}

export function allowsSelectedAgent(
  data: NewSessionRouteData | undefined,
  selectedAgentId: string,
  selectedAgent: unknown,
): boolean {
  const catalogAgentId = agentId(data);
  return (
    !catalogAgentId ||
    (normalizeAgentId(selectedAgentId) === catalogAgentId && Boolean(selectedAgent))
  );
}

export function render(data?: NewSessionRouteData) {
  if (!data?.catalogLabel) {
    return nothing;
  }
  return html`<span class="new-session-page__trigger new-session-page__runtime" title=${data.model}>
    <span class="new-session-page__target-icon" aria-hidden="true">${icons.terminal}</span>
    <span>${data.catalogLabel}</span>
  </span>`;
}

export function renderBar(params: {
  data?: NewSessionRouteData;
  agentSelect: unknown;
  folderSelect: unknown;
  whereSelect: unknown;
}) {
  return html`
    <div class="new-session-page__triggers">
      ${render(params.data)} ${agentId(params.data) ? nothing : params.agentSelect}
      ${params.folderSelect} ${params.whereSelect}
    </div>
  `;
}
