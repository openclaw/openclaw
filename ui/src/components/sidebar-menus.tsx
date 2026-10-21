import type { JSX } from "@solidjs/web";
import { createMemo, merge, onCleanup, Show } from "solid-js";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import {
  navigationIconForRoute,
  titleForRoute,
  type NavigationRouteId,
} from "../app-navigation.ts";
import { isSessionRouteId, pathForRoute } from "../app-route-paths.ts";
import { createIdentityAvatars } from "../lib/identity-avatar-loader.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { cancelRoutePreload, scheduleRoutePreload } from "../lib/route-preload.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import { createSidebarCatalogMenu } from "./app-sidebar-catalog-menu.tsx";
import {
  isSidebarRouteActive,
  renderSidebarNavLink as SidebarNavLink,
} from "./app-sidebar-nav-menus.tsx";
import type {
  SidebarRecentSession,
  SidebarSessionGroupMenuState,
  SidebarSessionMenuState,
} from "./app-sidebar-session-types.ts";
import type { SessionMenuWork } from "./session-menu-solid.tsx";
import { SESSION_MENU_OPEN_EVENT } from "./session-progress-hovercard-target.ts";
import type { SidebarMenusOwner, SidebarRouteView } from "./sidebar-menus-types.ts";
import { Icon } from "./solid/icon.tsx";
import type { MenuHandle } from "./solid/menu.tsx";

const AGENT_MENU_HOVER_OPEN_DELAY_MS = 300;
const AGENT_MENU_HOVER_CLOSE_DELAY_MS = 200;
const AGENT_MENU_WIDTH_PX = 300;

type MenuPosition = { x: number; y: number };
const positionedMenus = [
  "railPin",
  "pluginNavigation",
  "sessionSort",
  "peopleFilter",
  "catalogView",
  "identity",
] as const;
type PositionedMenu = (typeof positionedMenus)[number];
type MenuTrigger = PositionedMenu | "session" | "sessionGroup" | "agent";

function menuPosition(x: number, y: number, width: number, height: number): MenuPosition {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  };
}

export type SidebarFilterMenuView = "root" | "specific-owner";

type SidebarMenusRenderer = typeof import("./sidebar-menus-render.tsx");
type CatalogMenuView = ReturnType<ReturnType<typeof createSidebarCatalogMenu>["createView"]>;

type SidebarMenusState = {
  railPinMenuPosition: (MenuPosition & { entry: string; label: string }) | null;
  pluginNavigationMenuPosition:
    | (MenuPosition & { entry: ControlUiRegistration<ControlUiNavigationItem> })
    | null;
  sessionMenu: SidebarSessionMenuState | null;
  sessionMenuWork: SessionMenuWork | null;
  sessionGroupMenu: SidebarSessionGroupMenuState | null;
  sessionSortMenuPosition: MenuPosition | null;
  peopleFilterMenuPosition: MenuPosition | null;
  catalogViewMenuPosition: (MenuPosition & { catalogId: string }) | null;
  filterMenuView: SidebarFilterMenuView;
  agentMenuPosition: { x: number; top: number; placement?: "right-start" } | null;
  agentMenuMode: "hover" | "click";
  // Anchored by its bottom edge so the footer menu grows upward.
  identityMenuPosition: {
    x: number;
    bottom: number;
    width: number;
    placement?: "right-end";
  } | null;
  menuRenderer: SidebarMenusRenderer | null;
};

export type SidebarMenus = ReturnType<typeof createSidebarMenus>;

/** Presentation survives view replacement; attachment owns the external resources. */
export function createSidebarMenus(deps: {
  host: SidebarMenusOwner;
  element: HTMLElement;
  commit: () => Promise<boolean>;
}) {
  const { host, element, commit } = deps;
  const catalogMenu = createSidebarCatalogMenu(host, () => {
    menus.dismissTransientMenus();
    loadMenuRenderer();
  });
  const state: SidebarMenusState = {
    railPinMenuPosition: null,
    pluginNavigationMenuPosition: null,
    sessionMenu: null,
    sessionMenuWork: null,
    sessionGroupMenu: null,
    sessionSortMenuPosition: null,
    peopleFilterMenuPosition: null,
    catalogViewMenuPosition: null,
    filterMenuView: "root",
    agentMenuPosition: null,
    agentMenuMode: "click",
    identityMenuPosition: null,
    menuRenderer: null,
  };
  const listeners = new Set<() => void>();
  const triggers = new Map<MenuTrigger, HTMLElement | null>();
  const menuHandles = new Map<"catalogView" | "agent", MenuHandle>();
  let focusAgentRoster: (() => void) | undefined;
  const agentMenuAvatars = createIdentityAvatars();
  const routePreloadTimers = new Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>();
  let sessionMenuWork: ReturnType<SidebarMenusRenderer["createSessionMenuWork"]> | undefined;
  let agentMenuHoverOpenTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let agentMenuHoverCloseTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let agentMenuFocusBeforeHover: HTMLElement | null = null;
  let pluginActionLifetime = new AbortController();
  let disposed = false;
  let catalogMenuView: CatalogMenuView | undefined;
  const menuRendererImport = createIdleImport(
    () => import("./sidebar-menus-render.tsx"),
    (renderer) => {
      if (!disposed) {
        sessionMenuWork = renderer.createSessionMenuWork(host, (work) =>
          setField("sessionMenuWork", work),
        );
        if (!pluginActionLifetime.signal.aborted && state.sessionMenu) {
          sessionMenuWork.load(state.sessionMenu.session);
        }
        setField("menuRenderer", renderer);
      }
    },
  );

  function setField<Key extends keyof SidebarMenusState>(
    key: Key,
    value: SidebarMenusState[Key],
  ): void {
    if (Object.is(state[key], value)) {
      return;
    }
    state[key] = value;
    listeners.forEach((listener) => listener());
    void commit();
  }

  const loadMenuRenderer = () => void menuRendererImport.load().catch(() => undefined);

  function openPositionedMenu<Menu extends PositionedMenu>(
    menu: Menu,
    position: SidebarMenusState[`${Menu}MenuPosition`],
    trigger: HTMLElement | null,
  ) {
    loadMenuRenderer();
    menus.dismissTransientMenus();
    triggers.set(menu, trigger);
    setField(`${menu}MenuPosition`, position);
  }

  function openAgentMenu(trigger: HTMLElement, mode: "hover" | "click") {
    clearAgentMenuHoverTimers();
    loadMenuRenderer();
    const rect = trigger.getBoundingClientRect();
    const rail = !trigger.closest(".shell--mobile-nav") ? trigger.closest(".sidebar-rail") : null;
    menus.closeSessionMenu();
    menus.closeSessionGroupMenu();
    menus.closePositionedMenu("sessionSort");
    menus.closePositionedMenu("catalogView");
    menus.closePositionedMenu("identity");
    menus.closePositionedMenu("peopleFilter");
    triggers.set("agent", trigger);
    agentMenuFocusBeforeHover =
      mode === "hover" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    host.ensureAgentIdentities(host.activeChipAgent().agents.map((agent) => agent.id));
    setField("agentMenuMode", mode);
    setField(
      "agentMenuPosition",
      rail
        ? { x: rail.getBoundingClientRect().right, top: rect.top, placement: "right-start" }
        : {
            x: Math.max(8, Math.min(rect.left, window.innerWidth - AGENT_MENU_WIDTH_PX - 8)),
            top: Math.min(rect.bottom + 4, window.innerHeight - 8),
          },
    );
  }

  function scheduleAgentMenuHoverClose() {
    if (!state.agentMenuPosition || state.agentMenuMode !== "hover") {
      return;
    }
    globalThis.clearTimeout(agentMenuHoverCloseTimer ?? undefined);
    // The menu is top-layer content separated from its trigger by a gap.
    // A short grace period keeps crossing that gap from collapsing the target.
    agentMenuHoverCloseTimer = globalThis.setTimeout(() => {
      agentMenuHoverCloseTimer = null;
      if (!state.agentMenuPosition || state.agentMenuMode !== "hover") {
        return;
      }
      if (document.activeElement?.closest(".sidebar-agent-menu")) {
        return;
      }
      menus.closeAgentMenu();
    }, AGENT_MENU_HOVER_CLOSE_DELAY_MS);
  }

  function releaseTrigger(menu: MenuTrigger, restoreFocus = false) {
    const trigger = triggers.get(menu);
    triggers.delete(menu);
    if (restoreFocus) {
      trigger?.focus();
    }
  }

  function clearAgentMenuHoverTimers() {
    globalThis.clearTimeout(agentMenuHoverOpenTimer ?? undefined);
    globalThis.clearTimeout(agentMenuHoverCloseTimer ?? undefined);
    agentMenuHoverOpenTimer = null;
    agentMenuHoverCloseTimer = null;
  }

  const menus = merge(state, {
    catalogMenu,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      disposed = true;
      menus.disconnect();
      listeners.clear();
    },
    get catalogMenuView() {
      return catalogMenuView!;
    },
    // Mounted rows bind before rendering; old cleanup cannot release their replacement.
    bindCatalogMenuView(view: CatalogMenuView) {
      catalogMenuView = view;
      return () => {
        if (catalogMenuView === view) {
          catalogMenuView = undefined;
        }
      };
    },
    element,
    triggers,
    railPins: new Map<string, HTMLElement>(),
    get focusAgentRoster() {
      return focusAgentRoster;
    },
    set focusAgentRoster(focus: (() => void) | undefined) {
      focusAgentRoster = focus;
    },
    menuRef(menu: "catalogView" | "agent") {
      let bound: MenuHandle | undefined;
      onCleanup(() => {
        if (menuHandles.get(menu) === bound) {
          menuHandles.delete(menu);
        }
      });
      return (handle: MenuHandle) => {
        bound = handle;
        menuHandles.set(menu, handle);
      };
    },
    commit,
    get pluginActionLifetime() {
      return pluginActionLifetime;
    },
    connect(): void {
      agentMenuAvatars.connect();
      if (pluginActionLifetime.signal.aborted) {
        pluginActionLifetime = new AbortController();
        if (state.sessionMenu) {
          sessionMenuWork?.load(state.sessionMenu.session);
        }
      }
    },

    disconnect(): void {
      agentMenuAvatars.disconnect();
      pluginActionLifetime.abort();
      menuRendererImport.dispose();
      sessionMenuWork?.release();
      clearAgentMenuHoverTimers();
      for (const timer of routePreloadTimers.values()) {
        globalThis.clearTimeout(timer);
      }
      routePreloadTimers.clear();
    },

    preloadMenuRenderer: menuRendererImport.load,

    closePositionedMenu(menu: PositionedMenu, options: { restoreFocus?: boolean } = {}) {
      setField(`${menu}MenuPosition`, null);
      releaseTrigger(menu, options.restoreFocus);
    },

    positionedMenuHandlers(menu: PositionedMenu) {
      const position = state[`${menu}MenuPosition`];
      const trigger = triggers.get(menu);
      return {
        anchor: trigger ?? undefined,
        onClose: (restoreFocus?: boolean) => {
          if (state[`${menu}MenuPosition`] === position) {
            menus.closePositionedMenu(menu, { restoreFocus });
          }
        },
      };
    },

    // Dismiss before CSS hides the panel, releasing document-level menu shortcuts.
    dismissTransientMenus(): boolean {
      const hadTransientMenu = Boolean(
        positionedMenus.some((menu) => state[`${menu}MenuPosition`]) ||
        state.sessionMenu ||
        catalogMenu.isOpen() ||
        state.sessionGroupMenu ||
        state.agentMenuPosition,
      );
      for (const menu of positionedMenus) {
        menus.closePositionedMenu(menu);
      }
      menus.closeSessionMenu();
      catalogMenu.close();
      menus.closeSessionGroupMenu();
      menus.closeAgentMenu();
      return hadTransientMenu;
    },

    preloadRoute(routeId: NavigationRouteId, event: Event, immediate = false) {
      scheduleRoutePreload(
        routePreloadTimers,
        routeId,
        event,
        (nextRouteId) => host.onPreloadRoute?.(nextRouteId),
        routeId === host.activeRouteId || !menus.isRouteEnabled(routeId),
        immediate,
      );
    },

    isRouteEnabled(routeId: NavigationRouteId): boolean {
      return host.enabledRouteIds?.includes(routeId) ?? true;
    },

    openRailPinMenu(
      entry: string,
      label: string,
      x: number,
      y: number,
      trigger: HTMLElement | null,
    ) {
      openPositionedMenu("railPin", { ...menuPosition(x, y, 200, 140), entry, label }, trigger);
    },

    togglePositionedMenu(menu: "peopleFilter" | "sessionSort", trigger: HTMLElement) {
      if (state[`${menu}MenuPosition`]) {
        menus.closePositionedMenu(menu);
        return;
      }
      const rect = trigger.getBoundingClientRect();
      if (menu === "peopleFilter") {
        host.peopleView?.dismiss();
      }
      const [width, height] = menu === "peopleFilter" ? [320, 160] : [200, 280];
      openPositionedMenu(menu, menuPosition(rect.right, rect.bottom + 4, width, height), trigger);
    },

    openPluginNavigationMenu(
      entry: ControlUiRegistration<ControlUiNavigationItem>,
      x: number,
      y: number,
      trigger: HTMLElement,
    ) {
      if (entry.signal.aborted || !entry.value.actions?.length) {
        return;
      }
      openPositionedMenu(
        "pluginNavigation",
        {
          ...menuPosition(x, y, 240, entry.value.actions.length * 40 + 16),
          entry,
        },
        trigger,
      );
    },

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
      if (!host.selectedSessionKeys.has(session.key)) {
        host.clearSessionSelection();
      }
      loadMenuRenderer();
      menus.dismissTransientMenus();
      triggers.set("session", trigger);
      setField("sessionMenu", { session, x, y });
      sessionMenuWork?.load(session);
    },

    closeSessionMenu() {
      sessionMenuWork?.release();
      triggers.set("session", null);
      setField("sessionMenu", null);
      setField("sessionMenuWork", null);
    },

    openSessionGroupMenu(group: string, x: number, y: number, trigger: HTMLElement | null) {
      loadMenuRenderer();
      menus.dismissTransientMenus();
      triggers.set("sessionGroup", trigger);
      setField("sessionGroupMenu", {
        group,
        ...menuPosition(x, y, 224, 160),
      });
    },

    closeSessionGroupMenu(options: { restoreFocus?: boolean } = {}) {
      setField("sessionGroupMenu", null);
      releaseTrigger("sessionGroup", options.restoreFocus);
    },

    toggleCatalogViewMenu(catalogId: string, trigger: HTMLElement) {
      if (state.catalogViewMenuPosition?.catalogId === catalogId) {
        menus.closePositionedMenu("catalogView");
        return;
      }
      const rect = trigger.getBoundingClientRect();
      menus.openCatalogViewMenu(catalogId, rect.right, rect.bottom + 4, trigger);
    },

    openCatalogViewMenu(
      catalogId: string,
      x: number,
      y: number,
      trigger: HTMLElement | null = null,
    ) {
      setField("filterMenuView", "root");
      openPositionedMenu("catalogView", { catalogId, ...menuPosition(x, y, 200, 360) }, trigger);
    },

    setFilterMenuView(view: SidebarFilterMenuView) {
      if (!state.catalogViewMenuPosition) {
        return;
      }
      setField("filterMenuView", view);
      void commit().then((committed) => {
        if (!committed) {
          return;
        }
        const handle = triggers.get("catalogView") && menuHandles.get("catalogView");
        if (!handle) {
          return;
        }
        handle.overlay.surface.scrollTop = 0;
        handle.focusFirst();
      });
    },

    toggleAgentMenu(trigger: HTMLElement) {
      clearAgentMenuHoverTimers();
      if (state.agentMenuPosition && state.agentMenuMode === "click") {
        menus.closeAgentMenu();
        return;
      }
      if (state.agentMenuPosition && state.agentMenuMode === "hover") {
        agentMenuFocusBeforeHover = null;
        setField("agentMenuMode", "click");
        // Promotion does not reopen the dropdown, so after-show will not move focus.
        void commit().then((committed) => {
          if (!committed) {
            return;
          }
          if (
            !state.agentMenuPosition ||
            state.agentMenuMode !== "click" ||
            triggers.get("agent") !== trigger
          ) {
            return;
          }
          menuHandles.get("agent")?.focusFirst();
        });
        return;
      }
      openAgentMenu(trigger, "click");
    },

    scheduleAgentMenuHoverOpen(trigger: HTMLElement, event: PointerEvent) {
      globalThis.clearTimeout(agentMenuHoverCloseTimer ?? undefined);
      agentMenuHoverCloseTimer = null;
      // Pointer motion establishes intent; layout-only entry must not open the menu.
      if (
        state.agentMenuPosition ||
        agentMenuHoverOpenTimer !== null ||
        event.pointerType === "touch" ||
        !globalThis.matchMedia("(hover: hover) and (pointer: fine)").matches
      ) {
        return;
      }
      loadMenuRenderer();
      agentMenuHoverOpenTimer = globalThis.setTimeout(() => {
        agentMenuHoverOpenTimer = null;
        openAgentMenu(trigger, "hover");
      }, AGENT_MENU_HOVER_OPEN_DELAY_MS);
    },

    handleAgentMenuTriggerPointerLeave() {
      globalThis.clearTimeout(agentMenuHoverOpenTimer ?? undefined);
      agentMenuHoverOpenTimer = null;
      scheduleAgentMenuHoverClose();
    },

    handleAgentMenuPointerEnter() {
      globalThis.clearTimeout(agentMenuHoverCloseTimer ?? undefined);
      agentMenuHoverCloseTimer = null;
    },

    handleAgentMenuPointerLeave: scheduleAgentMenuHoverClose,

    restoreFocusAfterAgentMenuHoverOpen() {
      const chip = host.activeChipAgent();
      const activeItem =
        host.sidebarAgentsMode === "roster" && chip.agents.length > 1
          ? "scope:all"
          : `agent:${encodeURIComponent(chip.activeId)}`;
      menuHandles.get("agent")?.itemElement(activeItem)?.scrollIntoView?.({ block: "nearest" });
      if (!state.agentMenuPosition || state.agentMenuMode !== "hover") {
        return;
      }
      const previous = agentMenuFocusBeforeHover;
      agentMenuFocusBeforeHover = null;
      if (previous && previous !== document.body && previous.isConnected) {
        previous.focus({ preventScroll: true });
      } else if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest(".sidebar-agent-menu")
      ) {
        document.activeElement.blur();
      }
    },

    closeAgentMenu(options: { restoreFocus?: boolean } = {}) {
      clearAgentMenuHoverTimers();
      agentMenuFocusBeforeHover = null;
      setField("agentMenuPosition", null);
      releaseTrigger("agent", options.restoreFocus);
    },

    toggleIdentityMenu(trigger: HTMLElement) {
      if (state.identityMenuPosition) {
        menus.closePositionedMenu("identity");
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const menuWidth = Math.max(240, rect.width);
      const rail = !trigger.closest(".shell--mobile-nav") ? trigger.closest(".sidebar-rail") : null;
      openPositionedMenu(
        "identity",
        {
          x: rail
            ? rail.getBoundingClientRect().right
            : Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
          bottom: Math.max(8, window.innerHeight - (rail ? rect.bottom : rect.top) + 4),
          width: rect.width,
          ...(rail ? { placement: "right-end" as const } : {}),
        },
        trigger,
      );
    },

    render(view: SidebarMenusOwner): JSX.Element {
      const projection = projectOwner(menus, (owner) => owner);
      return (
        <Show when={projection.read().menuRenderer} keyed>
          {(renderer) =>
            renderer.renderSidebarMenus(menus, view, agentMenuAvatars, projection.revision)
          }
        </Show>
      );
    },

    renderRoute(
      routeId: NavigationRouteId,
      view: SidebarRouteView,
      triggerRef?: (element: HTMLAnchorElement) => void,
    ): JSX.Element {
      const sessionTarget = createMemo(() => {
        const routeSessionKey = isSessionRouteId(routeId) ? view.getRouteSessionKey() : "";
        const context = view.sessionDataContext;
        return isSessionRouteId(routeId) && routeSessionKey && context
          ? sessionNavigationTarget({ context, face: routeId, sessionKey: routeSessionKey })
          : null;
      });
      // Menus retain this anchor as their return-focus target across sidebar updates.
      const link = (
        <SidebarNavLink
          ref={triggerRef}
          icon={<Icon name={navigationIconForRoute(routeId)} />}
          label={titleForRoute(routeId)}
          href={sessionTarget()?.href ?? pathForRoute(routeId, view.basePath)}
          active={isSidebarRouteActive(view.activeRouteId, routeId)}
          onNavigate={() => view.onNavigate?.(routeId, sessionTarget()?.options)}
          onPreload={(event, immediate) => menus.preloadRoute(routeId, event, immediate)}
          onCancelPreload={menus.cancelPreload}
        />
      );
      return <Show when={view.enabledRouteIds?.includes(routeId) ?? true}>{link}</Show>;
    },
    cancelPreload: (event: Event) => cancelRoutePreload(routePreloadTimers, event),
  });
  return menus;
}
