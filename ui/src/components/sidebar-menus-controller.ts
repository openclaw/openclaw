import { html, nothing, type ReactiveController } from "lit";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import {
  cancelRoutePreload,
  scheduleRoutePreload,
  type NavigationRouteId,
} from "../app-navigation.ts";
import { isSessionRouteId, pathForRoute } from "../app-route-paths.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { IdentityAvatarController } from "../lib/identity-avatar-loader.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../lib/session-pull-requests.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { parseAgentSessionKey, scopedSessionArtifactKey } from "../lib/sessions/session-key.ts";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import { SidebarCatalogMenuController } from "./app-sidebar-catalog-menu.ts";
import { isSidebarRouteActive, renderSidebarNavRoute } from "./app-sidebar-nav-menus.ts";
import type {
  SidebarRecentSession,
  SidebarSessionGroupMenuState,
  SidebarSessionMenuState,
} from "./app-sidebar-session-types.ts";
import { fetchSessionMenuWork } from "./session-menu-work.ts";
import type { SessionMenuWork } from "./session-menu.ts";
import { SESSION_MENU_OPEN_EVENT } from "./session-progress-hovercard-target.ts";
import type { SidebarMenusControllerHost } from "./sidebar-menus-controller-types.ts";

const AGENT_MENU_HOVER_OPEN_DELAY_MS = 300;
const AGENT_MENU_HOVER_CLOSE_DELAY_MS = 200;
const AGENT_MENU_WIDTH_PX = 264;

type AgentMenuInteractionState = "closed" | "hover-pending" | "open-hover" | "open-click";

type MenuPosition = { x: number; y: number };
type CatalogMenuPosition = MenuPosition & { catalogId: string };
type PositionedMenu =
  | "customize"
  | "more"
  | "pluginNavigation"
  | "sessionSort"
  | "peopleFilter"
  | "catalogView"
  | "identity";

function menuPosition(x: number, y: number, width: number, height: number): MenuPosition {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  };
}

export type SidebarFilterMenuView = "root" | "specific-owner";

type SidebarMenusRenderer = typeof import("./sidebar-menus-render.ts");

/** Popup ownership and stateless menu-renderer wiring. */
export class SidebarMenusController implements ReactiveController {
  customizeMenuPosition: { x: number; y: number } | null = null;
  moreMenuPosition: { x: number; y: number } | null = null;
  pluginNavigationMenuPosition:
    | (MenuPosition & { entry: ControlUiRegistration<ControlUiNavigationItem> })
    | null = null;
  sessionMenu: SidebarSessionMenuState | null = null;
  sessionMenuWork: SessionMenuWork | null = null;
  sessionGroupMenu: SidebarSessionGroupMenuState | null = null;
  sessionSortMenuPosition: MenuPosition | null = null;
  peopleFilterMenuPosition: MenuPosition | null = null;
  catalogViewMenuPosition: CatalogMenuPosition | null = null;
  filterMenuView: SidebarFilterMenuView = "root";
  agentMenuPosition: { x: number; top: number } | null = null;
  // Anchored by its bottom edge so the footer menu grows upward regardless of height.
  identityMenuPosition: { x: number; bottom: number; width: number } | null = null;

  customizeMenuTrigger: HTMLElement | null = null;
  moreMenuTrigger: HTMLElement | null = null;
  pluginNavigationMenuTrigger: HTMLElement | null = null;
  sessionMenuTrigger: HTMLElement | null = null;
  private sessionMenuWorkVersion = 0;
  sessionGroupMenuTrigger: HTMLElement | null = null;
  sessionSortMenuTrigger: HTMLElement | null = null;
  peopleFilterMenuTrigger: HTMLElement | null = null;
  catalogViewMenuTrigger: HTMLElement | null = null;
  agentMenuTrigger: HTMLElement | null = null;
  agentMenuInteractionState: AgentMenuInteractionState = "closed";
  identityMenuTrigger: HTMLElement | null = null;
  private agentMenuHoverOpenTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private agentMenuHoverCloseTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private agentMenuFocusBeforeHover: HTMLElement | null = null;
  private readonly routePreloadTimers = new Map<
    EventTarget,
    ReturnType<typeof globalThis.setTimeout>
  >();
  private menuRenderer: SidebarMenusRenderer | null = null;
  // Popup rendering pulls Web Awesome menu code out of startup JS. It preloads
  // at idle and is requested immediately by the first menu interaction.
  private readonly menuRendererImport = createIdleImport(
    () => import("./sidebar-menus-render.ts"),
    (renderer) => {
      this.menuRenderer = renderer;
      this.host.requestUpdate();
    },
  );
  readonly catalogMenu: SidebarCatalogMenuController;
  readonly agentMenuAvatars: IdentityAvatarController;
  pluginActionLifetime = new AbortController();

  constructor(readonly host: SidebarMenusControllerHost) {
    host.addController(this);
    this.agentMenuAvatars = new IdentityAvatarController(host);
    this.catalogMenu = new SidebarCatalogMenuController(host, () => {
      this.dismissTransientMenus();
    });
  }

  hostConnected(): void {
    if (this.pluginActionLifetime.signal.aborted) {
      this.pluginActionLifetime = new AbortController();
    }
    this.menuRendererImport.schedule();
  }

  hostDisconnected(): void {
    this.pluginActionLifetime.abort();
    this.menuRendererImport.dispose();
    this.clearAgentMenuHoverTimers();
    for (const timer of this.routePreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.routePreloadTimers.clear();
  }

  private updateState<Key extends keyof SidebarMenusController>(
    this: SidebarMenusController,
    key: Key,
    value: SidebarMenusController[Key],
  ): void {
    this[key] = value;
    this.host.requestUpdate();
  }

  preloadMenuRenderer() {
    return this.menuRendererImport.load();
  }

  private loadMenuRenderer() {
    void this.preloadMenuRenderer().catch(() => undefined);
  }

  closePositionedMenu(menu: PositionedMenu, options: { restoreFocus?: boolean } = {}) {
    const trigger = this[`${menu}MenuTrigger`];
    this[`${menu}MenuTrigger`] = null;
    this.updateState(`${menu}MenuPosition`, null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  // The shell calls this before CSS hides the panel or drawer. Mounted menus
  // keep document-level shortcuts alive even when an ancestor is hidden.
  dismissTransientMenus(): boolean {
    const hadTransientMenu = Boolean(
      this.customizeMenuPosition ||
      this.moreMenuPosition ||
      this.pluginNavigationMenuPosition ||
      this.sessionMenu ||
      this.catalogMenu.isOpen ||
      this.sessionGroupMenu ||
      this.sessionSortMenuPosition ||
      this.peopleFilterMenuPosition ||
      this.catalogViewMenuPosition ||
      this.agentMenuPosition ||
      this.identityMenuPosition,
    );
    this.closePositionedMenu("customize");
    this.closePositionedMenu("more");
    this.closePositionedMenu("pluginNavigation");
    this.closeSessionMenu();
    this.catalogMenu.close();
    this.closePositionedMenu("peopleFilter");
    this.closeSessionGroupMenu();
    this.closePositionedMenu("sessionSort");
    this.closePositionedMenu("catalogView");
    this.closeAgentMenu();
    this.closePositionedMenu("identity");
    return hadTransientMenu;
  }

  preloadRoute(routeId: NavigationRouteId, event: Event, immediate = false) {
    scheduleRoutePreload(
      this.routePreloadTimers,
      routeId,
      event,
      (nextRouteId) => this.host.onPreloadRoute?.(nextRouteId),
      routeId === this.host.activeRouteId || !this.isRouteEnabled(routeId),
      immediate,
    );
  }

  readonly cancelPreload = (event: Event) => {
    cancelRoutePreload(this.routePreloadTimers, event);
  };

  isRouteEnabled(routeId: NavigationRouteId): boolean {
    return this.host.enabledRouteIds?.includes(routeId) ?? true;
  }

  readonly openCustomizeMenuFromContext = (event: MouseEvent) => {
    event.preventDefault();
    this.openCustomizeMenu(event.clientX, event.clientY);
  };

  openCustomizeMenu(x: number, y: number, trigger: HTMLElement | null = null) {
    this.loadMenuRenderer();
    this.dismissTransientMenus();
    this.customizeMenuTrigger = trigger;
    this.updateState("customizeMenuPosition", menuPosition(x, y, 240, 420));
  }

  toggleMoreMenu(trigger: HTMLElement) {
    if (this.moreMenuPosition) {
      this.closePositionedMenu("more");
      return;
    }
    this.loadMenuRenderer();
    const rect = trigger.getBoundingClientRect();
    this.dismissTransientMenus();
    this.moreMenuTrigger = trigger;
    this.updateState("moreMenuPosition", menuPosition(rect.left, rect.bottom + 4, 240, 420));
  }

  openPluginNavigationMenu(
    entry: ControlUiRegistration<ControlUiNavigationItem>,
    x: number,
    y: number,
    trigger: HTMLElement,
  ) {
    if (entry.signal.aborted || !entry.value.actions?.length) {
      return;
    }
    this.loadMenuRenderer();
    this.dismissTransientMenus();
    this.pluginNavigationMenuTrigger = trigger;
    this.updateState("pluginNavigationMenuPosition", {
      ...menuPosition(x, y, 240, entry.value.actions.length * 40 + 16),
      entry,
    });
  }

  /** A row outside the current selection retargets before the menu opens. */
  openSessionMenu(
    session: SidebarRecentSession,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ) {
    trigger?.dispatchEvent(
      new CustomEvent(SESSION_MENU_OPEN_EVENT, { bubbles: true, composed: true }),
    );
    if (!this.host.selectedSessionKeys.has(session.key)) {
      this.host.clearSessionSelection();
    }
    this.loadMenuRenderer();
    this.dismissTransientMenus();
    this.sessionMenuTrigger = trigger;
    this.updateState("sessionMenu", { session, x, y });
    this.loadSessionMenuWork(session);
  }

  closeSessionMenu() {
    const gateway = this.host.sessionDataContext?.gateway;
    if (gateway) {
      sessionPullRequestsForGateway(gateway).unwatch(this);
    }
    this.sessionMenuTrigger = null;
    this.sessionMenuWorkVersion += 1;
    this.updateState("sessionMenu", null);
    this.updateState("sessionMenuWork", null);
  }

  private loadSessionMenuWork(session: SidebarRecentSession) {
    const version = ++this.sessionMenuWorkVersion;
    if (!session.worktreeId) {
      this.updateState("sessionMenuWork", null);
      return;
    }
    this.updateState("sessionMenuWork", {
      loading: true,
      pullRequestUrl: null,
      worktreePath: null,
    });
    const context = this.host.sessionDataContext;
    const client = context?.gateway.snapshot.client;
    if (!context || !client) {
      this.updateState("sessionMenuWork", {
        loading: false,
        pullRequestUrl: null,
        worktreePath: null,
      });
      return;
    }
    const { selectedAgentId } = this.host.getSessionNavigationState();
    const store = sessionPullRequestsForGateway(context.gateway);
    const pullRequestKey = scopedSessionArtifactKey(
      session.key,
      parseAgentSessionKey(session.key)?.agentId ?? selectedAgentId,
    );
    void fetchSessionMenuWork({
      client,
      loadPullRequests: canCallGatewayMethod(
        context.gateway.snapshot,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "operator.read",
      )
        ? () => store.load(this, pullRequestKey)
        : undefined,
      worktreeId: session.worktreeId,
      execNode: session.execNode,
    }).then((work) => {
      if (version === this.sessionMenuWorkVersion) {
        this.updateState("sessionMenuWork", { loading: false, ...work });
      }
    });
  }

  openSessionGroupMenu(group: string, x: number, y: number, trigger: HTMLElement | null) {
    this.loadMenuRenderer();
    this.dismissTransientMenus();
    this.sessionGroupMenuTrigger = trigger;
    this.updateState("sessionGroupMenu", {
      group,
      ...menuPosition(x, y, 224, 160),
    });
  }

  closeSessionGroupMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.sessionGroupMenuTrigger;
    this.sessionGroupMenuTrigger = null;
    this.updateState("sessionGroupMenu", null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  togglePeopleFilterMenu(trigger: HTMLElement) {
    if (this.peopleFilterMenuPosition) {
      this.closePositionedMenu("peopleFilter");
      return;
    }
    this.loadMenuRenderer();
    const rect = trigger.getBoundingClientRect();
    this.dismissTransientMenus();
    this.host.people.dismiss();
    this.peopleFilterMenuTrigger = trigger;
    this.updateState(
      "peopleFilterMenuPosition",
      menuPosition(rect.right, rect.bottom + 4, 320, 160),
    );
  }

  toggleSessionSortMenu(trigger: HTMLElement) {
    if (this.sessionSortMenuPosition) {
      this.closePositionedMenu("sessionSort");
      return;
    }
    this.loadMenuRenderer();
    const rect = trigger.getBoundingClientRect();
    this.dismissTransientMenus();
    this.sessionSortMenuTrigger = trigger;
    this.updateState(
      "sessionSortMenuPosition",
      menuPosition(rect.right, rect.bottom + 4, 200, 280),
    );
  }

  toggleCatalogViewMenu(catalogId: string, trigger: HTMLElement) {
    if (this.catalogViewMenuPosition?.catalogId === catalogId) {
      this.closePositionedMenu("catalogView");
      return;
    }
    const rect = trigger.getBoundingClientRect();
    this.openCatalogViewMenu(catalogId, rect.right, rect.bottom + 4, trigger);
  }

  openCatalogViewMenu(catalogId: string, x: number, y: number, trigger: HTMLElement | null = null) {
    this.loadMenuRenderer();
    this.dismissTransientMenus();
    this.catalogViewMenuTrigger = trigger;
    this.filterMenuView = "root";
    this.updateState("catalogViewMenuPosition", {
      catalogId,
      ...menuPosition(x, y, 200, 360),
    });
  }

  setFilterMenuView(view: SidebarFilterMenuView) {
    if (!this.catalogViewMenuPosition) {
      return;
    }
    this.filterMenuView = view;
    this.host.requestUpdate();
    this.focusFilterMenuView();
  }

  private focusFilterMenuView() {
    void this.host.updateComplete.then(() => {
      const trigger = this.catalogViewMenuTrigger;
      const dropdown = trigger
        ?.closest("openclaw-app-sidebar")
        ?.querySelector<HTMLElement>(".sidebar-session-sort-menu");
      const menu = dropdown?.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
      if (!dropdown || !menu) {
        return;
      }
      menu.scrollTop = 0;
      dropdown.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])")?.focus();
    });
  }

  toggleAgentMenu(trigger: HTMLElement) {
    this.clearAgentMenuHoverTimers();
    if (this.agentMenuInteractionState === "open-click") {
      this.closeAgentMenu();
      return;
    }
    if (this.agentMenuInteractionState === "open-hover") {
      this.agentMenuFocusBeforeHover = null;
      this.updateState("agentMenuInteractionState", "open-click");
      // Promotion does not reopen the dropdown, so after-show will not move focus.
      void this.host.updateComplete.then(() => {
        if (this.agentMenuInteractionState !== "open-click" || this.agentMenuTrigger !== trigger) {
          return;
        }
        const dropdown = this.host.querySelector<HTMLElement>(".sidebar-agent-menu");
        if (dropdown) {
          this.menuRenderer?.focusActiveAgentMenuItem(dropdown);
        }
      });
      return;
    }
    this.openAgentMenu(trigger, "open-click");
  }

  private openAgentMenu(trigger: HTMLElement, interactionState: "open-hover" | "open-click") {
    this.clearAgentMenuHoverTimers();
    this.loadMenuRenderer();
    const menuWidth = AGENT_MENU_WIDTH_PX;
    const rect = trigger.getBoundingClientRect();
    this.closePositionedMenu("customize");
    this.closePositionedMenu("more");
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closePositionedMenu("sessionSort");
    this.closePositionedMenu("catalogView");
    this.closePositionedMenu("identity");
    this.closePositionedMenu("peopleFilter");
    this.agentMenuTrigger = trigger;
    this.agentMenuFocusBeforeHover =
      interactionState === "open-hover" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.updateState("agentMenuInteractionState", interactionState);
    // The agent card sits at the top of the sidebar, so the menu drops below it
    // and shares its left edge; anchoring above would cover the card you clicked.
    this.updateState("agentMenuPosition", {
      x: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
      top: Math.min(rect.bottom + 4, window.innerHeight - 8),
    });
  }

  scheduleAgentMenuHoverOpen(trigger: HTMLElement, event: PointerEvent) {
    globalThis.clearTimeout(this.agentMenuHoverCloseTimer ?? undefined);
    this.agentMenuHoverCloseTimer = null;
    // Pointer motion establishes intent; layout-only entry must not open the menu.
    if (
      this.agentMenuInteractionState !== "closed" ||
      event.pointerType === "touch" ||
      !globalThis.matchMedia("(hover: hover) and (pointer: fine)").matches
    ) {
      return;
    }
    this.loadMenuRenderer();
    globalThis.clearTimeout(this.agentMenuHoverOpenTimer ?? undefined);
    this.updateState("agentMenuInteractionState", "hover-pending");
    this.agentMenuHoverOpenTimer = globalThis.setTimeout(() => {
      this.agentMenuHoverOpenTimer = null;
      if (this.agentMenuInteractionState === "hover-pending") {
        this.openAgentMenu(trigger, "open-hover");
      }
    }, AGENT_MENU_HOVER_OPEN_DELAY_MS);
  }

  handleAgentMenuTriggerPointerLeave() {
    globalThis.clearTimeout(this.agentMenuHoverOpenTimer ?? undefined);
    this.agentMenuHoverOpenTimer = null;
    if (this.agentMenuInteractionState === "hover-pending") {
      this.updateState("agentMenuInteractionState", "closed");
      return;
    }
    this.scheduleAgentMenuHoverClose();
  }

  handleAgentMenuPointerEnter() {
    globalThis.clearTimeout(this.agentMenuHoverCloseTimer ?? undefined);
    this.agentMenuHoverCloseTimer = null;
  }

  handleAgentMenuPointerLeave() {
    this.scheduleAgentMenuHoverClose();
  }

  restoreFocusAfterAgentMenuHoverOpen() {
    if (this.agentMenuInteractionState !== "open-hover") {
      return;
    }
    const previous = this.agentMenuFocusBeforeHover;
    this.agentMenuFocusBeforeHover = null;
    if (previous && previous !== document.body && previous.isConnected) {
      previous.focus({ preventScroll: true });
    } else if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest(".sidebar-agent-menu")
    ) {
      document.activeElement.blur();
    }
  }

  closeAgentMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.agentMenuTrigger;
    this.clearAgentMenuHoverTimers();
    this.agentMenuTrigger = null;
    this.agentMenuFocusBeforeHover = null;
    this.updateState("agentMenuInteractionState", "closed");
    this.updateState("agentMenuPosition", null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  private scheduleAgentMenuHoverClose() {
    if (this.agentMenuInteractionState !== "open-hover") {
      return;
    }
    globalThis.clearTimeout(this.agentMenuHoverCloseTimer ?? undefined);
    // The menu is top-layer content separated from its trigger by a 4px gap.
    // A short grace period keeps crossing that gap from collapsing the target.
    this.agentMenuHoverCloseTimer = globalThis.setTimeout(() => {
      this.agentMenuHoverCloseTimer = null;
      if (this.agentMenuInteractionState !== "open-hover") {
        return;
      }
      if (document.activeElement?.closest(".sidebar-agent-menu")) {
        return;
      }
      this.closeAgentMenu();
    }, AGENT_MENU_HOVER_CLOSE_DELAY_MS);
  }

  private clearAgentMenuHoverTimers() {
    globalThis.clearTimeout(this.agentMenuHoverOpenTimer ?? undefined);
    globalThis.clearTimeout(this.agentMenuHoverCloseTimer ?? undefined);
    this.agentMenuHoverOpenTimer = null;
    this.agentMenuHoverCloseTimer = null;
  }

  toggleIdentityMenu(trigger: HTMLElement) {
    if (this.identityMenuPosition) {
      this.closePositionedMenu("identity");
      return;
    }
    this.loadMenuRenderer();
    const rect = trigger.getBoundingClientRect();
    const menuWidth = Math.max(240, rect.width);
    this.dismissTransientMenus();
    this.identityMenuTrigger = trigger;
    this.updateState("identityMenuPosition", {
      x: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 4),
      width: rect.width,
    });
  }

  render() {
    const renderer = this.menuRenderer;
    return html`
      ${renderer?.renderSidebarCustomizeMenuForController(this) ?? nothing}
      ${renderer?.renderSidebarMoreMenuForController(this) ?? nothing}
      ${renderer?.renderSidebarPluginNavigationMenuForController(this) ?? nothing}
      ${this.agentMenuAvatars.withActiveRoutes(
        () => renderer?.renderSidebarAgentMenuForController(this) ?? nothing,
      )}
      ${renderer?.renderSidebarIdentityMenuForController(this) ?? nothing}
      ${renderer?.renderSidebarSessionMenuForController(this) ?? nothing}
      ${this.catalogMenu.render()}
      ${renderer?.renderSidebarSessionGroupMenuForController(this) ?? nothing}
      ${renderer?.renderSidebarSessionSortMenuForController(this) ?? nothing}
      ${renderer?.renderSidebarPeopleFilterMenuForController(this) ?? nothing}
      ${renderer?.renderSidebarCatalogViewMenuForController(this) ?? nothing}
    `;
  }

  renderRoute(routeId: NavigationRouteId) {
    if (!this.isRouteEnabled(routeId)) {
      return nothing;
    }
    const routeSessionKey = isSessionRouteId(routeId) ? this.host.getRouteSessionKey() : "";
    const context = this.host.sessionDataContext;
    const sessionTarget =
      isSessionRouteId(routeId) && routeSessionKey && context
        ? sessionNavigationTarget({ context, face: routeId, sessionKey: routeSessionKey })
        : null;
    return renderSidebarNavRoute({
      routeId,
      href: sessionTarget?.href ?? pathForRoute(routeId, this.host.basePath),
      active: isSidebarRouteActive(this.host.activeRouteId, routeId),
      onNavigate: () => {
        this.host.onNavigate?.(routeId, sessionTarget?.options);
      },
      onPreload: (event, immediate) => this.preloadRoute(routeId, event, immediate),
      onCancelPreload: this.cancelPreload,
    });
  }
}
