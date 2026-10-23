import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, For, Show } from "solid-js";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForAgentPanel } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { t } from "../lib/reactive/i18n.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { SidebarDropdown } from "./app-sidebar-nav-menus.tsx";
import { COMMAND_VALUE_PREFIX } from "./sidebar-identity-menu-links.tsx";
import { Icon } from "./solid/icon.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import {
  createMenuControls,
  type MenuControls,
  type MenuEntry,
  type MenuHandle,
  type MenuItem,
} from "./solid/menu.tsx";

const AGENT_VALUE_PREFIX = "agent:";

type SidebarAgentMenuSwitcherParams = {
  activeId: string;
  allAgentsScope: boolean;
  openMode: "hover" | "click";
  agents: readonly GatewayAgentRow[];
  pendingAgent?: GatewayAgentRow;
  recentlyCreatedAgentId?: string;
  identities: ReadonlyMap<string, AgentIdentityResult>;
  resolveAvatarUrl: (url: string) => string | null;
  avatarErrorHandler: (url: string) => () => void;
  agentUnreadCount: (agentId: string) => number;
  onAgentSettings: (agentId: string) => void;
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
  controls?: MenuControls,
) {
  const agentId = createMemo(() => normalizeAgentId(readAgent().id));
  const pending = createMemo(() => params.pendingAgent?.id === agentId());
  const identity = createMemo(() => params.identities.get(agentId()) ?? null);
  const label = createMemo(() => normalizeAgentLabel(readAgent(), identity()));
  const active = createMemo(() => agentId() === params.activeId && !params.allAgentsScope);
  const unread = createMemo(() =>
    agentId() === params.activeId ? 0 : params.agentUnreadCount(agentId()),
  );
  return {
    as: "div",
    get disabled() {
      return pending();
    },
    id: `${AGENT_VALUE_PREFIX}${encodeURIComponent(agentId())}`,
    get label() {
      return [label(), unread() > 0 ? t("sessionsView.unread") : null].filter(Boolean).join(" ");
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
        "aria-disabled": pending() ? ("true" as const) : undefined,
        "data-initial-focus": readAutofocus() ? "" : undefined,
      };
    },
    content: (
      <span class="sidebar-agent-menu__agent-row">
        <span class="sidebar-agent-menu__agent-avatar">{renderAgentAvatar(readAgent, params)}</span>
        <span class="agent-select__option-copy">
          <span class="agent-select__option-heading">
            <span class="agent-select__option-label">{label()}</span>
          </span>
        </span>
        <span class="sidebar-agent-menu__agent-status">
          {unread() > 0 ? (
            <span class="session-unread-dot" role="img" aria-label={t("sessionsView.unread")} />
          ) : undefined}
          {pending() ? (
            <span role="status" aria-label={t("agentChip.creatingAgent")}>
              <span class="btn__spinner" aria-hidden="true" />
            </span>
          ) : (
            <button
              ref={controls?.ref()}
              type="button"
              class="sidebar-agent-menu__settings"
              aria-label={t("agentChip.namedSettings", { name: label() })}
              tabindex="-1"
              data-form-control
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                params.onAgentSettings(agentId());
              }}
            >
              <Icon name="settings" />
            </button>
          )}
        </span>
      </span>
    ),
  } satisfies MenuItem;
}

function renderSidebarAgentMenuSwitcher(
  params: SidebarAgentMenuSwitcherParams,
  controls?: MenuControls,
): MenuEntry[] {
  const agents = createMemo(() => {
    const pending = params.pendingAgent;
    const roster = pending
      ? [pending, ...params.agents.filter((agent) => normalizeAgentId(agent.id) !== pending.id)]
      : [...params.agents];
    const firstId = pending?.id ?? params.recentlyCreatedAgentId;
    return roster.toSorted((a, b) => Number(b.id === firstId) - Number(a.id === firstId));
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
  if (agents().length === 0) {
    return entries;
  }
  if (agents().length > 1) {
    entries.push({
      id: "scope:all",
      get label() {
        return t("agentChip.showAll");
      },
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
        controls,
      ),
    );
  }
  return entries;
}

export function renderSidebarAgentMenu(
  params: Omit<SidebarAgentMenuSwitcherParams, "allAgentsScope" | "onAgentSettings"> & {
    position: { x: number; top: number; placement?: "right-start" };
    anchor?: HTMLElement;
    basePath: string;
    rosterMode: boolean;
    creationDisabledReason: string | null;
    onShowAllAgents: () => void;
    onCreateAgent: () => void;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onAfterShow: () => void;
    onSwitchAgent: (agentId: string) => void;
    onClose: (restoreFocus?: boolean) => void;
    onNavigate: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
    ref?: (handle: MenuHandle) => void;
  },
): JSX.Element {
  const controls = createMenuControls();
  const creationReasonId = createUniqueId();
  const hasMultipleAgents = () =>
    params.agents.length +
      Number(
        Boolean(
          params.pendingAgent &&
          !params.agents.some((agent) => agent.id === params.pendingAgent?.id),
        ),
      ) >
    1;
  const menuLabel = createMemo(() =>
    t(params.rosterMode ? "agentChip.workspaceMenuLabel" : "agentChip.menuLabel"),
  );
  const agentsTitle = <div class="sidebar-customize-menu__title">{t("agentChip.agents")}</div>;
  const createAgentItem: MenuItem = {
    id: `${COMMAND_VALUE_PREFIX}new-agent`,
    get label() {
      return t("agentChip.createAgent");
    },
    get class() {
      return [
        "sidebar-customize-menu__item sidebar-agent-menu__create",
        { "session-menu__item--described": Boolean(params.creationDisabledReason) },
      ];
    },
    get disabled() {
      return Boolean(params.creationDisabledReason || params.pendingAgent);
    },
    get attributes() {
      return {
        "aria-disabled":
          params.creationDisabledReason || params.pendingAgent ? ("true" as const) : undefined,
        "aria-describedby": params.creationDisabledReason ? creationReasonId : undefined,
      };
    },
    closeOnSelect: false,
    content: (
      <span class="sidebar-agent-menu__agent-row">
        <span class="sidebar-agent-menu__create-icon" aria-hidden="true">
          <Icon name="circlePlus" />
        </span>
        <span class="agent-select__option-copy">
          <span
            class="agent-select__option-label"
            role={params.pendingAgent ? "status" : undefined}
          >
            {t(params.pendingAgent ? "agentChip.creatingAgent" : "agentChip.createAgent")}
          </span>
          <Show when={params.creationDisabledReason}>
            {(reason) => (
              <span id={creationReasonId} class="session-menu__description">
                {reason()}
              </span>
            )}
          </Show>
        </span>
      </span>
    ),
  };
  const items = createMemo<MenuEntry[]>(() => [
    ...(params.agents.length > 0
      ? [
          {
            kind: "content" as const,
            id: "agents-title",
            content: agentsTitle,
          },
        ]
      : []),
    createAgentItem,
    {
      kind: "group",
      id: "agents",
      class: "sidebar-agent-menu__agent-list",
      items: renderSidebarAgentMenuSwitcher(
        {
          ...params,
          allAgentsScope: params.rosterMode && hasMultipleAgents(),
          onAgentSettings: (agentId) => {
            params.onClose(false);
            params.onNavigate("agents", {
              pathname: pathForAgentPanel(agentId, null, params.basePath),
            });
          },
        },
        controls,
      ),
    },
  ]);

  return (
    <SidebarDropdown
      controls={controls}
      class="sidebar-customize-menu sidebar-agent-menu"
      position={params.position}
      anchor={params.anchor}
      label={menuLabel()}
      focusOnOpen={params.openMode !== "hover"}
      ref={params.ref}
      items={items()}
      onPointerEnter={params.onPointerEnter}
      onPointerLeave={params.onPointerLeave}
      onAfterShow={params.onAfterShow}
      onClose={params.onClose}
      onSelect={(value) => {
        if (value === `${COMMAND_VALUE_PREFIX}new-agent`) {
          params.onCreateAgent();
          return;
        }
        params.onClose(value === "scope:all" && params.rosterMode);
        if (value.startsWith(AGENT_VALUE_PREFIX)) {
          params.onSwitchAgent(decodeURIComponent(value.slice(AGENT_VALUE_PREFIX.length)));
          return;
        }
        if (value === "scope:all") {
          params.onShowAllAgents();
        }
      }}
    />
  );
}
