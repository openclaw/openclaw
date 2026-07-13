import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { NewSessionRouteData } from "./location.ts";

export function routeKey(data?: NewSessionRouteData): string {
  return JSON.stringify([
    data?.agentId ?? "",
    data?.catalogId ?? "",
    data?.model ?? "",
    data?.catalogLabel ?? "",
  ]);
}

export function isTarget(data?: NewSessionRouteData): boolean {
  return Boolean(data?.catalogId && data.model && data.catalogLabel);
}

export function resolveAgentId(
  data: NewSessionRouteData | undefined,
  availableAgents: readonly { id: string }[],
  fallback: string,
): string {
  if (isTarget(data)) {
    return normalizeAgentId(fallback);
  }
  const requested = normalizeAgentId(data?.agentId ?? "");
  return availableAgents.some((candidate) => normalizeAgentId(candidate.id) === requested)
    ? requested
    : normalizeAgentId(fallback);
}

export function allowsSelectedAgent(
  data: NewSessionRouteData | undefined,
  selectedAgent: unknown,
): boolean {
  return !isTarget(data) || Boolean(selectedAgent);
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
      ${render(params.data)} ${isTarget(params.data) ? nothing : params.agentSelect}
      ${params.folderSelect} ${params.whereSelect}
    </div>
  `;
}
