import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { renderAgentSelectAvatar, renderAgentSelectCopy } from "./agent-select.ts";
import { icons } from "./icons.ts";

export const AGENT_VALUE_PREFIX = "agent:";

export type SidebarAgentMenuSwitcherParams = {
  activeId: string;
  allAgentsScope: boolean;
  query: string;
  openMode: "hover" | "click";
  agents: readonly GatewayAgentRow[];
  identities: ReadonlyMap<string, AgentIdentityResult>;
  pinnedAgentIds: readonly string[];
  onTogglePinnedAgent: (agentId: string) => Promise<void>;
  resolveAvatarUrl: (url: string) => string | null;
  avatarErrorHandler: (url: string) => () => void;
  agentUnreadCount: (agentId: string) => number;
};

function sidebarAgentMenuRows(params: {
  agents: readonly GatewayAgentRow[];
  pinnedAgentIds: readonly string[];
}) {
  const { agents } = params;
  const pinnedIds = new Set(params.pinnedAgentIds.map(normalizeAgentId));
  return agents.toSorted((a, b) => {
    const aPinned = pinnedIds.has(normalizeAgentId(a.id)) ? 0 : 1;
    const bPinned = pinnedIds.has(normalizeAgentId(b.id)) ? 0 : 1;
    return aPinned - bPinned;
  });
}

function renderAgentAvatar(agent: GatewayAgentRow, params: SidebarAgentMenuSwitcherParams) {
  const agentId = normalizeAgentId(agent.id);
  const identity = params.identities.get(agentId) ?? null;
  const avatarUrl = resolveAgentAvatarUrl(agent, identity);
  return renderAgentSelectAvatar(
    { value: agentId, label: normalizeAgentLabel(agent, identity), agent },
    identity,
    avatarUrl ? params.resolveAvatarUrl(avatarUrl) : null,
    avatarUrl ? params.avatarErrorHandler(avatarUrl) : undefined,
  );
}

function renderAgentGroupAvatar(
  agents: readonly GatewayAgentRow[],
  params: SidebarAgentMenuSwitcherParams,
) {
  const visibleAgents = agents.slice(0, agents.length > 4 ? 3 : 4);
  const remaining = agents.length - visibleAgents.length;
  return html`
    <span
      class="sidebar-agent-menu__agent-avatar sidebar-agent-menu__avatar-group ${
        agents.length === 2
          ? "sidebar-agent-menu__avatar-group--pair"
          : agents.length === 3
            ? "sidebar-agent-menu__avatar-group--triple"
            : ""
      }"
      aria-hidden="true"
    >
      ${visibleAgents.map(
        (agent) => html`<span class="sidebar-agent-menu__group-item"
          >${renderAgentAvatar(agent, params)}</span
        >`,
      )}
      ${
        remaining > 0
          ? html`<span class="sidebar-agent-menu__group-item sidebar-agent-menu__group-count"
              >${remaining}+</span
            >`
          : nothing
      }
    </span>
  `;
}

function renderAgentRow(
  agent: GatewayAgentRow,
  params: SidebarAgentMenuSwitcherParams,
  autofocus: boolean,
  duplicateName: boolean,
) {
  const agentId = normalizeAgentId(agent.id);
  const identity = params.identities.get(agentId) ?? null;
  const label = normalizeAgentLabel(agent, identity);
  const active = agentId === params.activeId && !params.allAgentsScope;
  const pinned = params.pinnedAgentIds.includes(agentId);
  const pinLabel = t(pinned ? "agents.unpinFromSwitcher" : "agents.pinToSwitcher");
  const unread = agentId === params.activeId ? 0 : params.agentUnreadCount(agentId);
  const option = { value: agentId, label, agent, description: duplicateName ? agentId : undefined };
  const rowLabel = [label, option.description, unread > 0 ? t("sessionsView.unread") : null]
    .filter(Boolean)
    .join(" ");
  return html`
    <wa-dropdown-item
      class="sidebar-customize-menu__item sidebar-agent-menu__agent-switch agent-select__option ${
        active ? "sidebar-agent-menu__agent-switch--active" : ""
      }"
      value=${`${AGENT_VALUE_PREFIX}${encodeURIComponent(agentId)}`}
      aria-label=${rowLabel}
      aria-current=${active ? "true" : nothing}
      ?autofocus=${autofocus}
    >
      <span class="sidebar-agent-menu__agent-row">
        <span class="sidebar-agent-menu__agent-avatar"> ${renderAgentAvatar(agent, params)} </span>
        ${renderAgentSelectCopy(option)}
        <span class="sidebar-agent-menu__agent-status">
          ${
            params.agents.length > 3
              ? html`<button
                  type="button"
                  class="sidebar-agent-menu__pin"
                  aria-label=${`${pinLabel}: ${label}`}
                  title=${pinLabel}
                  aria-pressed=${String(pinned)}
                  tabindex="-1"
                  @click=${async (event: MouseEvent) => {
                    event.stopPropagation();
                    const button = event.currentTarget;
                    if (!(button instanceof HTMLButtonElement)) {
                      return;
                    }
                    // Moving a keyed row into pinned-first order can drop native focus.
                    const focused = button === document.activeElement;
                    await params.onTogglePinnedAgent(agentId);
                    if (focused && button.isConnected) {
                      button.focus({ preventScroll: true });
                    }
                  }}
                >
                  ${icons.pin}
                </button>`
              : nothing
          }
          ${
            unread > 0
              ? html`<span
                  class="session-unread-dot"
                  role="img"
                  aria-label=${t("sessionsView.unread")}
                ></span>`
              : nothing
          }
        </span>
      </span>
    </wa-dropdown-item>
  `;
}

export function renderSidebarAgentMenuSwitcher(params: SidebarAgentMenuSwitcherParams) {
  const agents = sidebarAgentMenuRows(params);
  const query = params.query.trim().toLocaleLowerCase();
  const nameCounts = new Map<string, number>();
  for (const agent of agents) {
    const label = normalizeAgentLabel(agent, params.identities.get(normalizeAgentId(agent.id)));
    nameCounts.set(label, (nameCounts.get(label) ?? 0) + 1);
  }
  const visibleAgents = agents.filter((agent) => {
    const label = normalizeAgentLabel(agent, params.identities.get(normalizeAgentId(agent.id)));
    return (
      !query ||
      label.toLocaleLowerCase().includes(query) ||
      agent.id.toLocaleLowerCase().includes(query)
    );
  });
  const autofocusAll = params.openMode === "click" && params.allAgentsScope && agents.length > 1;
  const autofocusAgent =
    params.openMode === "click" && !autofocusAll
      ? (agents.find((agent) => normalizeAgentId(agent.id) === params.activeId) ?? agents[0])
      : undefined;
  return html`
    ${
      params.agents.length > 0
        ? html`
            <div class="sidebar-agent-menu__agent-list">
              ${
                params.agents.length > 1 && !query
                  ? html`
                      <wa-dropdown-item
                        class="sidebar-customize-menu__item sidebar-agent-menu__agent-switch ${
                          params.allAgentsScope ? "sidebar-agent-menu__agent-switch--active" : ""
                        }"
                        value="scope:all"
                        aria-current=${params.allAgentsScope ? "true" : nothing}
                        ?autofocus=${autofocusAll}
                      >
                        <span class="sidebar-agent-menu__agent-row">
                          ${renderAgentGroupAvatar(agents, params)}
                          <span class="agent-select__option-copy"
                            ><span class="agent-select__option-label"
                              >${t("agentChip.showAll")}</span
                            ></span
                          >
                        </span>
                      </wa-dropdown-item>
                    `
                  : nothing
              }
              ${repeat(
                visibleAgents,
                (entry) => entry.id,
                (entry) =>
                  renderAgentRow(
                    entry,
                    params,
                    entry === autofocusAgent,
                    (nameCounts.get(
                      normalizeAgentLabel(entry, params.identities.get(normalizeAgentId(entry.id))),
                    ) ?? 0) > 1,
                  ),
              )}
              ${visibleAgents.length === 0 ? html`<div class="sidebar-agent-menu__empty" role="status">${t("agentChip.noMatches")}</div>` : nothing}
            </div>
          `
        : nothing
    }
  `;
}
