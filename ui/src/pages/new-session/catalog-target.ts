import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { NewSessionRouteData } from "./location.ts";

export function routeKey(data?: NewSessionRouteData): string {
  return JSON.stringify([data?.agentId ?? "", data?.catalogId ?? ""]);
}

export function isTarget(data?: NewSessionRouteData): boolean {
  return Boolean(data?.catalogId);
}

export function isResolvedTarget(data?: NewSessionRouteData): boolean {
  return Boolean(data?.catalogId && data.model && data.catalogLabel);
}

export function resolveAgentId(
  data: Pick<NewSessionRouteData, "agentId" | "catalogId"> | undefined,
  availableAgents: readonly { id: string }[],
  fallback: string,
): string {
  const requested = normalizeAgentId(data?.agentId ?? "");
  return availableAgents.some((candidate) => normalizeAgentId(candidate.id) === requested)
    ? requested
    : normalizeAgentId(fallback);
}

export function allowsSelectedAgent(
  data: NewSessionRouteData | undefined,
  selectedAgent: unknown,
): boolean {
  return !isTarget(data) || (isResolvedTarget(data) && Boolean(selectedAgent));
}

function render(data?: NewSessionRouteData) {
  if (!data?.catalogId) {
    return nothing;
  }
  const label = data.catalogLabel || data.catalogId;
  return html`<span
    class="new-session-page__trigger new-session-page__runtime"
    title=${data.model || label}
  >
    <span class="new-session-page__target-icon" aria-hidden="true">${icons.terminal}</span>
    <span>${label}</span>
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
      ${render(params.data)} ${isTarget(params.data) ? nothing : params.agentSelect}
      ${params.folderSelect} ${params.whereSelect}
    </div>
  `;
}
