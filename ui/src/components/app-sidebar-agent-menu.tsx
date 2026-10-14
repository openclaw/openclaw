import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import type { JSX } from "@solidjs/web";
import { createMemo, For } from "solid-js";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForAgentPanel } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { t } from "../lib/reactive/i18n.ts";
import { renderSidebarMenuAction } from "./app-sidebar-nav-menus.tsx";
import type { IconName } from "./icon-data.ts";
import {
  AGENT_VALUE_PREFIX,
  renderSidebarAgentMenuSwitcher,
  type SidebarAgentMenuSwitcherParams,
} from "./sidebar-agent-menu-switcher.tsx";
import { Icon } from "./solid/icon.tsx";
import { renderMenuTrigger } from "./solid/menu-trigger.tsx";
import { consumeDropdownKeyboardDismissal, trackDropdownKeyboardDismissal } from "./web-awesome.ts";

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
const sidebarMenuTypeahead = new WeakMap<
  HTMLElement,
  { query: string; timeout: ReturnType<typeof setTimeout> }
>();

function sidebarMenuItems(dropdown: Element | null) {
  return [
    ...(dropdown?.querySelectorAll<HTMLElement & { active: boolean }>(
      ":scope > wa-dropdown-item:not([disabled]), :scope > .sidebar-agent-menu__agent-list > wa-dropdown-item:not([disabled])",
    ) ?? []),
  ];
}

function focusSidebarMenuItem(
  items: Array<HTMLElement & { active: boolean }>,
  target: HTMLElement,
) {
  items.forEach((item) => (item.active = item === target));
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "nearest" });
}

// Nested overlays bubble lifecycle events through the dropdown. Only the
// owner's completed hide may remove its menu or consume its Escape state.
export function closeMenuAfterOwnDropdownHide(
  event: Event,
  onClose: (restoreFocus?: boolean) => void,
) {
  if (event.target !== event.currentTarget) {
    return;
  }
  onClose(consumeDropdownKeyboardDismissal(event));
}

export function consumeSidebarMenuSelection(
  event: WaSelectEvent,
  onClose: (restoreFocus?: boolean) => void,
): string | undefined {
  event.preventDefault();
  const item = event.detail.item;
  if (item.hasAttribute("data-native-navigation")) {
    item.removeAttribute("data-native-navigation");
    onClose(false);
    return undefined;
  }
  const value = item.getAttribute("value") ?? undefined;
  if (value) {
    onClose(false);
    if (value.startsWith(LINK_VALUE_PREFIX)) {
      openExternalUrlSafe(decodeURIComponent(value.slice(LINK_VALUE_PREFIX.length)));
      return undefined;
    }
  }
  return value;
}

export function moveSidebarMenuFocus(event: KeyboardEvent): boolean {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return false;
  }
  if (event.target instanceof HTMLInputElement && (event.key === "Home" || event.key === "End")) {
    return false;
  }
  // SAFETY: Sidebar dropdown keydown handlers call this with their HTMLElement as currentTarget.
  const dropdown = (event.currentTarget as HTMLElement).closest("wa-dropdown");
  const items = sidebarMenuItems(dropdown);
  const footer = dropdown?.querySelector<HTMLElement>(".sidebar-identity-menu__footer");
  const search = dropdown?.querySelector<HTMLInputElement>(".sidebar-agent-menu__filter");
  const controls = [
    ...(search ? [search] : []),
    ...items,
    ...(footer?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []),
  ];
  const current =
    event.target instanceof HTMLElement
      ? (event.target.closest<HTMLElement>("wa-dropdown-item") ?? event.target)
      : null;
  const index = current ? controls.indexOf(current) : -1;
  if (footer && index < 0) {
    return false;
  }
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const target =
    event.key === "Home"
      ? items[0]
      : event.key === "End"
        ? items.at(-1)
        : index < 0
          ? items.at(direction === 1 ? 0 : -1)
          : controls[(index + direction + controls.length) % controls.length];
  if (!target || (footer && !footer.contains(current) && !footer.contains(target))) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  // Native footer actions are outside Web Awesome's roving item list; reset
  // its active row on both crossings so reverse navigation cannot skip one.
  focusSidebarMenuItem(items, target);
  return true;
}

function typeaheadSidebarMenuFocus(event: KeyboardEvent): boolean {
  if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  const dropdown = event.currentTarget;
  if (!(dropdown instanceof HTMLElement)) {
    return false;
  }
  const previous = sidebarMenuTypeahead.get(dropdown);
  if (event.key === " " && !previous?.query) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  if (previous) {
    clearTimeout(previous.timeout);
  }
  const query = `${previous?.query ?? ""}${event.key}`.trim().toLowerCase();
  const timeout = setTimeout(() => sidebarMenuTypeahead.delete(dropdown), 1_000);
  sidebarMenuTypeahead.set(dropdown, { query, timeout });
  const items = sidebarMenuItems(dropdown);
  const target = items.find((item) =>
    (item.textContent ?? "").trim().toLowerCase().startsWith(query),
  );
  if (target) {
    focusSidebarMenuItem(items, target);
  }
  return true;
}

export function focusActiveAgentMenuItem(dropdown: HTMLElement) {
  const items = sidebarMenuItems(dropdown);
  const target = items.find((item) => item.hasAttribute("autofocus")) ?? items[0];
  if (!target) {
    return;
  }
  focusSidebarMenuItem(items, target);
}

type SidebarAgentMenuParams = Omit<SidebarAgentMenuSwitcherParams, "allAgentsScope"> & {
  position: { x: number; top: number };
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
  onTabAway: () => void;
  onClose: (restoreFocus?: boolean) => void;
  onNavigate: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
};

function renderIdentityMenuHelpSubmenu(): JSX.Element {
  return (
    <For each={IDENTITY_MENU_LINKS}>
      {(link) => (
        <wa-dropdown-item
          slot="submenu"
          class="sidebar-customize-menu__item"
          value={`${LINK_VALUE_PREFIX}${encodeURIComponent(link.href)}`}
          data-new-tab-action
          ref={(item) => {
            item.addEventListener("click", (event) => {
              if (event.target instanceof Element && event.target.closest("a")) {
                item.setAttribute("data-native-navigation", "");
              }
            });
          }}
        >
          <a
            href={link.href}
            target={EXTERNAL_LINK_TARGET}
            rel={buildExternalLinkRel()}
            tabindex="-1"
          >
            <span slot="icon" class="nav-item__icon" aria-hidden="true">
              <Icon name={link.icon} />
            </span>
            <span class="sidebar-customize-menu__text">{link.label()}</span>
          </a>
        </wa-dropdown-item>
      )}
    </For>
  );
}

export function renderSidebarHelpMenu(): JSX.Element {
  if (!currentThemeBranding().communityLinks) {
    return undefined;
  }
  return (
    <wa-dropdown-item
      class="sidebar-customize-menu__item sidebar-identity-menu__help"
      value="command:help"
    >
      <span slot="icon" class="nav-item__icon" aria-hidden="true">
        <Icon name="circleQuestionMark" />
      </span>
      <span class="sidebar-customize-menu__text">{t("agentChip.help")}</span>
      {renderIdentityMenuHelpSubmenu()}
    </wa-dropdown-item>
  );
}

export function renderSidebarAgentMenu(params: SidebarAgentMenuParams): JSX.Element {
  const position = params.position;
  const activeId = () => params.activeId;
  const activeName = () => params.activeName;
  const menuLabel = createMemo(() =>
    t(params.rosterMode ? "agentChip.workspaceMenuLabel" : "agentChip.menuLabel"),
  );
  return (
    <wa-dropdown
      class="sidebar-customize-menu sidebar-agent-menu"
      data-chat-autotype-exempt
      prop:open={true}
      placement="bottom-start"
      prop:distance={0}
      aria-label={menuLabel()}
      onPointerEnter={params.onPointerEnter}
      onPointerLeave={params.onPointerLeave}
      onWa-select={(event: WaSelectEvent) => {
        const value = consumeSidebarMenuSelection(event, (restoreFocus) =>
          params.onClose(
            restoreFocus ||
              (event.detail.item.getAttribute("value") === "scope:all" && params.rosterMode),
          ),
        );
        if (!value) {
          return;
        }
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
      onWa-after-show={params.onAfterShow}
      onKeyDown={(event: KeyboardEvent) => {
        const target = event.target;
        const row =
          target instanceof HTMLElement
            ? target.closest<HTMLElement>(".sidebar-agent-menu__agent-switch")
            : null;
        const pin = row?.querySelector<HTMLButtonElement>(".sidebar-agent-menu__pin");
        if (pin && target === pin && (event.key === "Enter" || event.key === " ")) {
          // Let the native button click without selecting its enclosing agent.
          event.stopPropagation();
          return;
        }
        if (
          event.key === "Tab" &&
          row &&
          pin &&
          ((target === row && !event.shiftKey) || (target === pin && event.shiftKey))
        ) {
          event.preventDefault();
          event.stopPropagation();
          (event.shiftKey ? row : pin).focus();
          return;
        }
        if (
          event.target instanceof HTMLInputElement &&
          (event.isComposing || !["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(event.key))
        ) {
          event.stopPropagation();
          return;
        }
        if (moveSidebarMenuFocus(event)) {
          return;
        }
        if (typeaheadSidebarMenuFocus(event)) {
          return;
        }
        const item =
          event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>(
                ".sidebar-agent-menu__agent-list > wa-dropdown-item:not([disabled])",
              )
            : null;
        if ((event.key === "Enter" || event.key === " ") && item) {
          event.preventDefault();
          event.stopPropagation();
          item.click();
          return;
        }
        // Let the dropdown consume Escape before the mobile drawer or settings shell.
        if (event.key === "Escape") {
          event.preventDefault();
        }
        trackDropdownKeyboardDismissal(event, params.onTabAway);
      }}
      onWa-after-hide={(event: Event) => closeMenuAfterOwnDropdownHide(event, params.onClose)}
    >
      {renderMenuTrigger(
        {
          get x() {
            return position.x;
          },
          get y() {
            return position.top;
          },
        },
        menuLabel(),
      )}
      {params.agents.length > 0 ? (
        <div class="sidebar-customize-menu__title">{t("agentChip.agents")}</div>
      ) : undefined}
      {params.agents.length > 6 ? (
        <input
          class="sidebar-agent-menu__filter"
          type="search"
          aria-label={t("agentChip.search")}
          placeholder={t("agentChip.search")}
          value={params.query}
          onInput={(event) => {
            params.onQueryChange(event.currentTarget.value);
          }}
        />
      ) : undefined}
      {renderSidebarAgentMenuSwitcher({
        get activeId() {
          return params.activeId;
        },
        get allAgentsScope() {
          return params.rosterMode && params.agents.length > 1;
        },
        get query() {
          return params.query;
        },
        get openMode() {
          return params.openMode;
        },
        get agents() {
          return params.agents;
        },
        get identities() {
          return params.identities;
        },
        get pinnedAgentIds() {
          return params.pinnedAgentIds;
        },
        onTogglePinnedAgent: (agentId) => params.onTogglePinnedAgent(agentId),
        resolveAvatarUrl: (url) => params.resolveAvatarUrl(url),
        avatarErrorHandler: (url) => params.avatarErrorHandler(url),
        agentUnreadCount: (agentId) => params.agentUnreadCount(agentId),
      })}
      {params.agents.length > 0 ? (
        <div class="sidebar-customize-menu__separator" role="separator" />
      ) : undefined}
      {renderSidebarMenuAction("command:new-agent", t("custodian.newAgent"), "userPlus")}
      {renderSidebarMenuAction("command:agents-directory", t("agentChip.seeAllAgents"), "list")}
      <div class="sidebar-customize-menu__separator" role="separator" />
      {activeId()
        ? renderSidebarMenuAction(
            "command:capabilities",
            t("agentChip.whatCanAgentDo", { name: activeName() }),
            "circleQuestionMark",
            {
              get disabled() {
                return !params.connected;
              },
            },
          )
        : undefined}
      {renderSidebarMenuAction(
        "command:agent-settings",
        activeId()
          ? t("agentChip.namedSettings", { name: activeName() })
          : t("agentChip.agentSettings"),
        "settings",
        {
          get disabled() {
            return !activeId();
          },
        },
      )}
    </wa-dropdown>
  );
}
