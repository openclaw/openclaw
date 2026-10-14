import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForAgentPanel } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { t } from "../lib/reactive/i18n.ts";
import { SidebarDropdown, renderSidebarMenuAction } from "./app-sidebar-nav-menus.tsx";
import type { IconName } from "./icon-data.ts";
import {
  AGENT_VALUE_PREFIX,
  renderSidebarAgentMenuSwitcher,
  type SidebarAgentMenuSwitcherParams,
} from "./sidebar-agent-menu-switcher.tsx";
import { Icon } from "./solid/icon.tsx";
import type { MenuEntry, MenuItem } from "./solid/menu.tsx";

// External rows of the footer identity menu. Docs-first: public docs pages over
// raw GitHub, matching the ClawSweeper docs-link policy for user-facing copy.
const IDENTITY_MENU_LINKS: ReadonlyArray<{
  href: string;
  icon: IconName;
  label: () => string;
}> = [
  { href: "https://docs.openclaw.ai", icon: "book", label: () => t("common.docs") },
  {
    href: "https://docs.openclaw.ai/help",
    icon: "messageSquare",
    label: () => t("agentChip.getHelp"),
  },
  { href: "https://discord.gg/clawd", icon: "users", label: () => t("agentChip.discord") },
  {
    href: "https://docs.openclaw.ai/releases",
    icon: "scrollText",
    label: () => t("agentChip.viewChangelog"),
  },
];

export const COMMAND_VALUE_PREFIX = "command:";
const LINK_VALUE_PREFIX = "link:";
type SidebarAgentMenuParams = Omit<SidebarAgentMenuSwitcherParams, "allAgentsScope"> & {
  position: { x: number; top: number };
  anchor?: HTMLElement;
  tabFocusTarget?: (backward: boolean) => HTMLElement | undefined;
  basePath: string;
  rosterMode: boolean;
  activeName: string;
  connected: boolean;
  onQueryChange: (query: string) => void;
  onToggleRoster: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onAfterShow: () => void;
  onSwitchAgent: (agentId: string) => void;
  onAskCapabilities: (agentId: string) => void;
  onClose: (restoreFocus?: boolean) => void;
  onNavigate: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
};

export function renderSidebarHelpMenu(): MenuItem | undefined {
  if (!currentThemeBranding().communityLinks) {
    return undefined;
  }
  return {
    ...renderSidebarMenuAction("command:help", t("agentChip.help"), "circleQuestionMark", {
      className: "sidebar-identity-menu__help",
    }),
    trigger: (
      <span class="sidebar-customize-menu__trigger">
        <span class="nav-item__icon" aria-hidden="true">
          <Icon name="circleQuestionMark" />
        </span>
        <span class="sidebar-customize-menu__text">{t("agentChip.help")}</span>
      </span>
    ),
    content: undefined,
    children: IDENTITY_MENU_LINKS.map((link) => ({
      id: `${LINK_VALUE_PREFIX}${encodeURIComponent(link.href)}`,
      label: link.label(),
      href: link.href,
      class: "sidebar-customize-menu__item",
      attributes: {
        "data-new-tab-action": "",
        target: EXTERNAL_LINK_TARGET,
        rel: buildExternalLinkRel(),
      },
      icon: (
        <span class="nav-item__icon" aria-hidden="true">
          <Icon name={link.icon} />
        </span>
      ),
      content: <span class="sidebar-customize-menu__text">{link.label()}</span>,
    })),
  };
}

export function selectSidebarHelpLink(value: string): boolean {
  if (!value.startsWith(LINK_VALUE_PREFIX)) {
    return false;
  }
  openExternalUrlSafe(decodeURIComponent(value.slice(LINK_VALUE_PREFIX.length)));
  return true;
}

export function renderSidebarAgentMenu(params: SidebarAgentMenuParams): JSX.Element {
  const position = params.position;
  const activeId = () => params.activeId;
  const activeName = () => params.activeName;
  const menuLabel = createMemo(() =>
    t(params.rosterMode ? "agentChip.workspaceMenuLabel" : "agentChip.menuLabel"),
  );
  const agentsTitle = <div class="sidebar-customize-menu__title">{t("agentChip.agents")}</div>;
  const agentsSeparator = <div class="sidebar-customize-menu__separator" role="separator" />;
  const settingsSeparator = <div class="sidebar-customize-menu__separator" role="separator" />;
  const items = (): MenuEntry[] => [
    ...(params.agents.length > 0
      ? [
          {
            kind: "content" as const,
            id: "agents-title",
            content: agentsTitle,
          },
        ]
      : []),
    ...(params.agents.length > 6
      ? [
          {
            id: "search",
            label: t("agentChip.search"),
            closeOnSelect: false,
            render: () => (
              <input
                class="sidebar-agent-menu__filter"
                data-search
                type="search"
                role="searchbox"
                aria-label={t("agentChip.search")}
                placeholder={t("agentChip.search")}
                value={params.query}
                onInput={(event) => params.onQueryChange(event.currentTarget.value)}
              />
            ),
          },
        ]
      : []),
    {
      kind: "group",
      id: "agents",
      class: "sidebar-agent-menu__agent-list",
      items: renderSidebarAgentMenuSwitcher({
        ...params,
        allAgentsScope: params.rosterMode && params.agents.length > 1,
      }),
    },
    ...(params.agents.length > 0
      ? [
          {
            kind: "content" as const,
            id: "agents-separator",
            content: agentsSeparator,
          },
        ]
      : []),
    renderSidebarMenuAction("command:new-agent", t("custodian.newAgent"), "userPlus"),
    renderSidebarMenuAction("command:agents-directory", t("agentChip.seeAllAgents"), "list"),
    {
      kind: "content",
      id: "settings-separator",
      content: settingsSeparator,
    },
    ...(activeId()
      ? [
          renderSidebarMenuAction(
            "command:capabilities",
            t("agentChip.whatCanAgentDo", { name: activeName() }),
            "circleQuestionMark",
            { disabled: !params.connected },
          ),
        ]
      : []),
    renderSidebarMenuAction(
      "command:agent-settings",
      activeId()
        ? t("agentChip.namedSettings", { name: activeName() })
        : t("agentChip.agentSettings"),
      "settings",
      { disabled: !activeId() },
    ),
  ];
  return (
    <SidebarDropdown
      class="sidebar-customize-menu sidebar-agent-menu"
      position={position}
      anchor={params.anchor}
      tabFocusTarget={params.tabFocusTarget}
      label={menuLabel()}
      focusOnOpen={params.openMode !== "hover"}
      items={items()}
      onPointerEnter={params.onPointerEnter}
      onPointerLeave={params.onPointerLeave}
      onAfterShow={params.onAfterShow}
      onClose={params.onClose}
      onSelect={(value) => {
        if (value === "search") {
          return;
        }
        params.onClose(value === "scope:all" && params.rosterMode);
        if (value.startsWith(AGENT_VALUE_PREFIX)) {
          params.onSwitchAgent(decodeURIComponent(value.slice(AGENT_VALUE_PREFIX.length)));
          return;
        }
        switch (value) {
          case "scope:all":
            if (!params.rosterMode) {
              params.onToggleRoster();
            }
            break;
          case `${COMMAND_VALUE_PREFIX}agents-directory`:
            params.onNavigate("agents-home");
            break;
          case `${COMMAND_VALUE_PREFIX}new-agent`:
            params.onNavigate("custodian", { search: "?intent=new-agent" });
            break;
          case `${COMMAND_VALUE_PREFIX}capabilities`:
            params.onAskCapabilities(activeId());
            break;
          case `${COMMAND_VALUE_PREFIX}agent-settings`:
            params.onNavigate("agents", {
              pathname: pathForAgentPanel(activeId(), null, params.basePath),
            });
            break;
        }
      }}
    />
  );
}
