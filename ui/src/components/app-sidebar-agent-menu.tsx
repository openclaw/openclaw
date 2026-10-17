import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, Show } from "solid-js";
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
type SidebarAgentMenuParams = Omit<
  SidebarAgentMenuSwitcherParams,
  "allAgentsScope" | "onAgentSettings"
> & {
  position: { x: number; top: number };
  anchor?: HTMLElement;
  tabFocusTarget?: (backward: boolean) => HTMLElement | undefined;
  basePath: string;
  rosterMode: boolean;
  creationDisabledReason: string | null;
  onShowAllAgents: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onAfterShow: () => void;
  onSwitchAgent: (agentId: string) => void;
  onCreateAgent: () => Promise<void>;
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

/** Promote a hover-open menu without letting the first Create row steal selection focus. */
export function focusSidebarAgentMenu(element: HTMLElement): void {
  const dropdown = element.querySelector<HTMLElement>(".sidebar-agent-menu");
  const target =
    dropdown?.querySelector<HTMLElement>(".sidebar-agent-menu__agent-switch--active") ??
    dropdown?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])');
  target?.focus();
}

export function renderSidebarAgentMenu(params: SidebarAgentMenuParams): JSX.Element {
  const position = params.position;
  const creationReasonId = createUniqueId();
  const menuLabel = createMemo(() =>
    t(params.rosterMode ? "agentChip.workspaceMenuLabel" : "agentChip.menuLabel"),
  );
  const agentsTitle = <div class="sidebar-customize-menu__title">{t("agentChip.agents")}</div>;
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
    {
      id: "command:new-agent",
      label: t("agentChip.createAgent"),
      class: [
        "sidebar-customize-menu__item sidebar-agent-menu__create",
        { "session-menu__item--described": Boolean(params.creationDisabledReason) },
      ],
      disabled: Boolean(params.creationDisabledReason || params.pendingAgent),
      attributes: {
        "aria-describedby": params.creationDisabledReason ? creationReasonId : undefined,
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
    },
    {
      kind: "group",
      id: "agents",
      class: "sidebar-agent-menu__agent-list",
      items: renderSidebarAgentMenuSwitcher({
        ...params,
        allAgentsScope: params.rosterMode && params.agents.length > 1,
        onAgentSettings: (agentId) => {
          params.onClose(false);
          params.onNavigate("agents", {
            pathname: pathForAgentPanel(agentId, null, params.basePath),
          });
        },
      }),
    },
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
        if (value === "command:new-agent") {
          void params.onCreateAgent();
          return;
        }
        params.onClose(value === "scope:all" && params.rosterMode);
        if (value.startsWith(AGENT_VALUE_PREFIX)) {
          params.onSwitchAgent(decodeURIComponent(value.slice(AGENT_VALUE_PREFIX.length)));
          return;
        }
        switch (value) {
          case "scope:all":
            params.onShowAllAgents();
            break;
        }
      }}
    />
  );
}
