import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, Show } from "solid-js";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForAgentPanel } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { SidebarDropdown } from "./app-sidebar-nav-menus.tsx";
import {
  AGENT_VALUE_PREFIX,
  renderSidebarAgentMenuSwitcher,
  type SidebarAgentMenuSwitcherParams,
} from "./sidebar-agent-menu-switcher.tsx";
import { COMMAND_VALUE_PREFIX } from "./sidebar-identity-menu-links.tsx";
import { Icon } from "./solid/icon.tsx";
import {
  createMenuControls,
  type MenuEntry,
  type MenuHandle,
  type MenuItem,
} from "./solid/menu.tsx";

type SidebarAgentMenuParams = Omit<
  SidebarAgentMenuSwitcherParams,
  "allAgentsScope" | "onAgentSettings"
> & {
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
};

export function renderSidebarAgentMenu(params: SidebarAgentMenuParams): JSX.Element {
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
