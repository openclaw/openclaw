import { createMemo, For } from "solid-js";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { t } from "../lib/reactive/i18n.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { Icon } from "./solid/icon.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
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
function renderAgentAvatar(
  readAgent: () => GatewayAgentRow,
  params: SidebarAgentMenuSwitcherParams,
) {
  const agentId = createMemo(() => normalizeAgentId(readAgent().id));
  const identity = createMemo(() => params.identities.get(agentId()) ?? null);
  const avatarUrl = createMemo(() => resolveAgentAvatarUrl(readAgent(), identity()));
  return (
    <AgentIdentityAvatar
      agent={{
        get id() {
          return readAgent().id;
        },
        get avatar() {
          const url = avatarUrl();
          return url ? params.resolveAvatarUrl(url) : null;
        },
        get textAvatar() {
          return resolveAgentTextAvatar(readAgent(), identity());
        },
      }}
      class="agent-select__avatar"
      onImageError={() => {
        const url = avatarUrl();
        if (url) {
          params.avatarErrorHandler(url)();
        }
      }}
    />
  );
}
function renderAgentGroupAvatar(
  agents: readonly GatewayAgentRow[],
  params: SidebarAgentMenuSwitcherParams,
) {
  const visibleAgents = createMemo(() => agents.slice(0, agents.length > 4 ? 3 : 4));
  const remaining = createMemo(() => agents.length - visibleAgents().length);
  return (
    <span
      class={`sidebar-agent-menu__agent-avatar sidebar-agent-menu__avatar-group ${agents.length === 2 ? "sidebar-agent-menu__avatar-group--pair" : agents.length === 3 ? "sidebar-agent-menu__avatar-group--triple" : ""}`}
      aria-hidden="true"
    >
      <For each={visibleAgents()}>
        {(agent) => (
          <span class="sidebar-agent-menu__group-item">
            {renderAgentAvatar(() => agent, params)}
          </span>
        )}
      </For>
      {remaining() > 0 ? (
        <span class="sidebar-agent-menu__group-item sidebar-agent-menu__group-count">
          {remaining()}+
        </span>
      ) : undefined}
    </span>
  );
}
function renderAgentRow(
  readAgent: () => GatewayAgentRow,
  params: SidebarAgentMenuSwitcherParams,
  readAutofocus: () => boolean,
  readDuplicateName: () => boolean,
) {
  const agentId = createMemo(() => normalizeAgentId(readAgent().id));
  const identity = createMemo(() => params.identities.get(agentId()) ?? null);
  const label = createMemo(() => normalizeAgentLabel(readAgent(), identity()));
  const active = createMemo(() => agentId() === params.activeId && !params.allAgentsScope);
  const pinned = createMemo(() => params.pinnedAgentIds.includes(agentId()));
  const pinLabel = createMemo(() =>
    t(pinned() ? "agents.unpinFromSwitcher" : "agents.pinToSwitcher"),
  );
  const unread = createMemo(() =>
    agentId() === params.activeId ? 0 : params.agentUnreadCount(agentId()),
  );
  const option = createMemo(() => ({
    value: agentId(),
    label: label(),
    agent: readAgent(),
    description: readDuplicateName() ? agentId() : undefined,
  }));
  const rowLabel = createMemo(() =>
    [label(), option().description, unread() > 0 ? t("sessionsView.unread") : null]
      .filter(Boolean)
      .join(" "),
  );
  return (
    <wa-dropdown-item
      class={`sidebar-customize-menu__item sidebar-agent-menu__agent-switch agent-select__option ${active() ? "sidebar-agent-menu__agent-switch--active" : ""}`}
      value={`${AGENT_VALUE_PREFIX}${encodeURIComponent(agentId())}`}
      aria-label={rowLabel()}
      aria-current={active() ? "true" : undefined}
      autofocus={readAutofocus()}
    >
      <span class="sidebar-agent-menu__agent-row">
        <span class="sidebar-agent-menu__agent-avatar">
          {" "}
          {renderAgentAvatar(readAgent, params)}{" "}
        </span>
        <span class="agent-select__option-copy">
          <span class="agent-select__option-heading">
            <span class="agent-select__option-label">{label()}</span>
          </span>
          {option().description ? (
            <span class="agent-select__option-description">{option().description}</span>
          ) : undefined}
        </span>
        <span class="sidebar-agent-menu__agent-status">
          {params.agents.length > 3 ? (
            <button
              type="button"
              class="sidebar-agent-menu__pin"
              aria-label={`${pinLabel()}: ${label()}`}
              title={pinLabel()}
              aria-pressed={pinned() ? "true" : "false"}
              tabindex="-1"
              onClick={(event) => {
                void (async () => {
                  event.stopPropagation();
                  const button = event.currentTarget;
                  // Moving a keyed row into pinned-first order can drop native focus.
                  const focused = button === document.activeElement;
                  await params.onTogglePinnedAgent(agentId());
                  if (focused && button.isConnected) {
                    button.focus({
                      preventScroll: true,
                    });
                  }
                })();
              }}
            >
              <Icon name="pin" />
            </button>
          ) : undefined}
          {unread() > 0 ? (
            <span class="session-unread-dot" role="img" aria-label={t("sessionsView.unread")} />
          ) : undefined}
        </span>
      </span>
    </wa-dropdown-item>
  );
}
export function renderSidebarAgentMenuSwitcher(params: SidebarAgentMenuSwitcherParams) {
  const agents = createMemo(() => sidebarAgentMenuRows(params));
  const query = createMemo(() => params.query.trim().toLocaleLowerCase());
  const nameCounts = createMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents()) {
      const label = normalizeAgentLabel(agent, params.identities.get(normalizeAgentId(agent.id)));
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  });
  const visibleAgents = createMemo(() =>
    agents().filter((agent) => {
      const label = normalizeAgentLabel(agent, params.identities.get(normalizeAgentId(agent.id)));
      return (
        !query() ||
        label.toLocaleLowerCase().includes(query()) ||
        agent.id.toLocaleLowerCase().includes(query())
      );
    }),
  );
  const autofocusAll = createMemo(
    () => params.openMode === "click" && params.allAgentsScope && agents().length > 1,
  );
  const autofocusAgent = createMemo(() =>
    params.openMode === "click" && !autofocusAll()
      ? (agents().find((agent) => normalizeAgentId(agent.id) === params.activeId) ?? agents()[0])
      : undefined,
  );
  return (
    <>
      {params.agents.length > 0 ? (
        <div class="sidebar-agent-menu__agent-list">
          {params.agents.length > 1 && !query() ? (
            <wa-dropdown-item
              class={`sidebar-customize-menu__item sidebar-agent-menu__agent-switch ${params.allAgentsScope ? "sidebar-agent-menu__agent-switch--active" : ""}`}
              value="scope:all"
              aria-current={params.allAgentsScope ? "true" : undefined}
              autofocus={autofocusAll()}
            >
              <span class="sidebar-agent-menu__agent-row">
                {renderAgentGroupAvatar(agents(), params)}
                <span class="agent-select__option-copy">
                  <span class="agent-select__option-label">{t("agentChip.showAll")}</span>
                </span>
              </span>
            </wa-dropdown-item>
          ) : undefined}
          <For each={visibleAgents()} keyed={(entry) => entry.id}>
            {(entry) =>
              renderAgentRow(
                entry,
                params,
                () => entry() === autofocusAgent(),
                () =>
                  (nameCounts().get(
                    normalizeAgentLabel(
                      entry(),
                      params.identities.get(normalizeAgentId(entry().id)),
                    ),
                  ) ?? 0) > 1,
              )
            }
          </For>
          {visibleAgents().length === 0 ? (
            <div class="sidebar-agent-menu__empty" role="status">
              {t("agentChip.noMatches")}
            </div>
          ) : undefined}
        </div>
      ) : undefined}
    </>
  );
}
