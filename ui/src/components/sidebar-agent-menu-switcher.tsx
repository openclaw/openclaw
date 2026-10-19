import { createMemo, For } from "solid-js";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { t } from "../lib/reactive/i18n.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { Icon } from "./solid/icon.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import type { MenuEntry, MenuItem } from "./solid/menu.tsx";
export const AGENT_VALUE_PREFIX = "agent:";
export type SidebarAgentMenuSwitcherParams = {
  activeId: string;
  allAgentsScope: boolean;
  openMode: "hover" | "click";
  agents: readonly GatewayAgentRow[];
  identities: ReadonlyMap<string, AgentIdentityResult>;
  pinnedAgentIds: readonly string[];
  onTogglePinnedAgent: (agentId: string) => Promise<void>;
  resolveAvatarUrl: (url: string) => string | null;
  avatarErrorHandler: (url: string) => () => void;
  agentUnreadCount: (agentId: string) => number;
};
function renderAgentAvatar(
  readAgent: () => GatewayAgentRow,
  params: SidebarAgentMenuSwitcherParams,
) {
  const identity = createMemo(
    () => params.identities.get(normalizeAgentId(readAgent().id)) ?? null,
  );
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
  const visibleAgents = agents.slice(0, agents.length > 4 ? 3 : 4);
  return (
    <span
      class={[
        "sidebar-agent-menu__agent-avatar sidebar-agent-menu__avatar-group",
        {
          "sidebar-agent-menu__avatar-group--pair": agents.length === 2,
          "sidebar-agent-menu__avatar-group--triple": agents.length === 3,
        },
      ]}
      aria-hidden="true"
    >
      <For each={visibleAgents}>
        {(agent) => (
          <span class="sidebar-agent-menu__group-item">
            {renderAgentAvatar(() => agent, params)}
          </span>
        )}
      </For>
      {agents.length > 4 ? (
        <span class="sidebar-agent-menu__group-item sidebar-agent-menu__group-count">
          {agents.length - visibleAgents.length}+
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
  pinButtons: Map<string, HTMLButtonElement>,
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
  const description = () => (readDuplicateName() ? agentId() : undefined);
  return {
    as: "div",
    id: `${AGENT_VALUE_PREFIX}${encodeURIComponent(agentId())}`,
    get label() {
      return [label(), description(), unread() > 0 ? t("sessionsView.unread") : null]
        .filter(Boolean)
        .join(" ");
    },
    get class() {
      return [
        "sidebar-customize-menu__item sidebar-agent-menu__agent-switch agent-select__option",
        { "sidebar-agent-menu__agent-switch--active": active() },
      ];
    },
    get attributes() {
      return {
        "aria-current": active() ? ("true" as const) : undefined,
        "data-initial-focus": readAutofocus() ? "" : undefined,
      };
    },
    content: (
      <span class="sidebar-agent-menu__agent-row">
        <span class="sidebar-agent-menu__agent-avatar">
          {" "}
          {renderAgentAvatar(readAgent, params)}{" "}
        </span>
        <span class="agent-select__option-copy">
          <span class="agent-select__option-heading">
            <span class="agent-select__option-label">{label()}</span>
          </span>
          {description() ? (
            <span class="agent-select__option-description">{description()}</span>
          ) : undefined}
        </span>
        <span class="sidebar-agent-menu__agent-status">
          {params.agents.length > 3 ? (
            <button
              ref={(button) => pinButtons.set(agentId(), button)}
              type="button"
              class="sidebar-agent-menu__pin"
              aria-label={`${pinLabel()}: ${label()}`}
              title={pinLabel()}
              aria-pressed={pinned() ? "true" : "false"}
              tabindex="-1"
              data-form-control
              onClick={(event) => {
                // Pinning does not select the enclosing agent.
                event.preventDefault();
                event.stopPropagation();
                const button = event.currentTarget;
                // Moving a keyed row into pinned-first order can drop native focus.
                const focused = button === document.activeElement;
                const id = agentId();
                void params.onTogglePinnedAgent(id).then(() => {
                  if (focused) {
                    const currentButton = pinButtons.get(id);
                    if (currentButton?.isConnected) {
                      currentButton.focus({ preventScroll: true });
                    }
                  }
                });
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
    ),
  } satisfies MenuItem;
}
export function renderSidebarAgentMenuSwitcher(
  params: SidebarAgentMenuSwitcherParams,
  pinButtons = new Map<string, HTMLButtonElement>(),
) {
  const agents = createMemo(() => {
    const pinnedIds = new Set(params.pinnedAgentIds.map(normalizeAgentId));
    return params.agents.toSorted(
      (a, b) =>
        Number(pinnedIds.has(normalizeAgentId(b.id))) -
        Number(pinnedIds.has(normalizeAgentId(a.id))),
    );
  });
  const nameCounts = createMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents()) {
      const label = normalizeAgentLabel(agent, params.identities.get(normalizeAgentId(agent.id)));
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  });
  const autofocusAll = createMemo(
    () => params.openMode === "click" && params.allAgentsScope && agents().length > 1,
  );
  const autofocusAgent = createMemo(() =>
    params.openMode === "click" && !autofocusAll()
      ? (agents().find((agent) => normalizeAgentId(agent.id) === params.activeId) ?? agents()[0])
      : undefined,
  );
  const entries: MenuEntry[] = [];
  if (params.agents.length === 0) {
    return entries;
  }
  if (params.agents.length > 1) {
    entries.push({
      id: "scope:all",
      label: t("agentChip.showAll"),
      class: [
        "sidebar-customize-menu__item sidebar-agent-menu__agent-switch",
        { "sidebar-agent-menu__agent-switch--active": params.allAgentsScope },
      ],
      attributes: {
        "aria-current": params.allAgentsScope ? "true" : undefined,
        "data-initial-focus": autofocusAll() ? "" : undefined,
      },
      content: (
        <span class="sidebar-agent-menu__agent-row">
          {renderAgentGroupAvatar(agents(), params)}
          <span class="agent-select__option-copy">
            <span class="agent-select__option-label">{t("agentChip.showAll")}</span>
          </span>
        </span>
      ),
    });
  }
  for (const agent of agents()) {
    entries.push(
      renderAgentRow(
        () => agent,
        params,
        () => agent === autofocusAgent(),
        () =>
          (nameCounts().get(
            normalizeAgentLabel(agent, params.identities.get(normalizeAgentId(agent.id))),
          ) ?? 0) > 1,
        pinButtons,
      ),
    );
  }
  return entries;
}
