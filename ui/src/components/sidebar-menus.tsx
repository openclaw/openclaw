import type { JSX } from "@solidjs/web";
import { createMemo, lazy, merge, onCleanup, Show } from "solid-js";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import {
  navigationIconForRoute,
  titleForRoute,
  type NavigationRouteId,
} from "../app-navigation.ts";
import { isSessionRouteId, pathForRoute } from "../app-route-paths.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { PendingSessionCreate } from "../pages/chat/pending-session-create-lazy.ts";
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
import { createSidebarRendererLoader } from "./sidebar-renderer-loader.tsx";
import { Icon } from "./solid/icon.tsx";
import type { MenuHandle } from "./solid/menu.tsx";

type MenuPosition = { x: number; y: number };
const positionedMenus = [
  "railPin",
  "pluginNavigation",
  "sessionSort",
  "peopleFilter",
  "automationsFilter",
  "catalogView",
  "identity",
] as const;
type PositionedMenu = (typeof positionedMenus)[number];
type MenuTrigger = PositionedMenu | "session" | "sessionGroup";

function menuPosition(x: number, y: number, width: number, height: number): MenuPosition {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  };
}

export type SidebarFilterMenuView = "root" | "specific-owner";

/** Sidebar header filters that open a positioned popover from their trigger. */
export type SidebarFilterMenu = "peopleFilter" | "sessionSort" | "automationsFilter";

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
  automationsFilterMenuPosition: MenuPosition | null;
  catalogViewMenuPosition: (MenuPosition & { catalogId: string }) | null;
  filterMenuView: SidebarFilterMenuView;
  agentCreateDialogOpen: boolean;
  // Anchored by its bottom edge so the footer menu grows upward.
  identityMenuPosition: {
    x: number;
    bottom: number;
    width: number;
    placement?: "right-end";
  } | null;
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
    automationsFilterMenuPosition: null,
    catalogViewMenuPosition: null,
    filterMenuView: "root",
    agentCreateDialogOpen: false,
    identityMenuPosition: null,
  };
  const listeners = new Set<() => void>();
  const triggers = new Map<MenuTrigger, HTMLElement | null>();
  const menuHandles = new Map<"catalogView", MenuHandle>();
  // Switching list modes replaces the row whose menu was used.
  let pendingAgentRowFocus: string | undefined;
  let sessionMenuWork: ReturnType<SidebarMenusRenderer["createSessionMenuWork"]> | undefined;
  let pluginActionLifetime = new AbortController();
  let disposed = false;
  let catalogMenuView: CatalogMenuView | undefined;
  const MenuRenderer = lazy(
    async () => {
      // A visible Create action can enter its pending chat synchronously.
      const [{ SidebarMenusRenderer, CatalogSessionMenu, createSessionMenuWork }] =
        await Promise.all([import("./sidebar-menus-render.tsx"), PendingSessionCreate.preload()]);
      return { SidebarMenusRenderer, CatalogSessionMenu, createSessionMenuWork };
    },
    { export: "SidebarMenusRenderer" },
  );
  const LazyCatalogMenu = lazy(MenuRenderer.preload, { export: "CatalogSessionMenu" });
  const menuRendererImport = createSidebarRendererLoader(async () => {
    const renderer = await MenuRenderer.preload();
    if (!disposed) {
      sessionMenuWork = renderer.createSessionMenuWork(host, (work) =>
        setField("sessionMenuWork", work),
      );
      if (!pluginActionLifetime.signal.aborted && state.sessionMenu) {
        sessionMenuWork.load(state.sessionMenu.session);
      }
    }
  });
  const Boundary = menuRendererImport.Boundary;
  const CatalogMenu = (props: Parameters<typeof LazyCatalogMenu>[0]) => (
    <Boundary>
      <LazyCatalogMenu {...props} />
    </Boundary>
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

  function releaseTrigger(menu: MenuTrigger, restoreFocus = false) {
    const trigger = triggers.get(menu);
    triggers.delete(menu);
    if (restoreFocus) {
      trigger?.focus();
    }
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
    requestAgentRowFocus(agentId: string) {
      pendingAgentRowFocus = agentId;
    },
    /** The replacement row takes the request once; any other row leaves focus alone. */
    claimAgentRowFocus(agentId: string): boolean {
      if (pendingAgentRowFocus !== agentId) {
        return false;
      }
      pendingAgentRowFocus = undefined;
      return true;
    },
    menuRef(menu: "catalogView") {
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
      if (pluginActionLifetime.signal.aborted) {
        pluginActionLifetime = new AbortController();
        if (state.sessionMenu) {
          sessionMenuWork?.load(state.sessionMenu.session);
        }
      }
    },

    disconnect(): void {
      pluginActionLifetime.abort();
      menuRendererImport.dispose();
      sessionMenuWork?.release();
    },

    async preloadMenuRenderer() {
      await Promise.all([menuRendererImport.load(), LazyCatalogMenu.preload()]);
    },

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
        state.sessionGroupMenu,
      );
      for (const menu of positionedMenus) {
        menus.closePositionedMenu(menu);
      }
      menus.closeSessionMenu();
      catalogMenu.close();
      menus.closeSessionGroupMenu();
      return hadTransientMenu;
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

    togglePositionedMenu(menu: SidebarFilterMenu, trigger: HTMLElement) {
      if (state[`${menu}MenuPosition`]) {
        menus.closePositionedMenu(menu);
        return;
      }
      const rect = trigger.getBoundingClientRect();
      if (menu === "peopleFilter") {
        host.peopleView?.dismiss();
      }
      // Section filters share the Users filter's popover and size.
      const [width, height] = menu === "sessionSort" ? [200, 280] : [320, 160];
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

    openAgentCreateDialog() {
      if (!host.sessionDataContext) {
        return;
      }
      loadMenuRenderer();
      setField("agentCreateDialogOpen", true);
    },

    closeAgentCreateDialog() {
      setField("agentCreateDialogOpen", false);
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
      return [
        <Show
          when={
            projection.read().railPinMenuPosition ||
            projection.read().pluginNavigationMenuPosition ||
            projection.read().agentCreateDialogOpen ||
            projection.read().identityMenuPosition ||
            projection.read().sessionMenu ||
            projection.read().sessionGroupMenu ||
            projection.read().sessionSortMenuPosition ||
            projection.read().peopleFilterMenuPosition ||
            projection.read().automationsFilterMenuPosition ||
            projection.read().catalogViewMenuPosition
          }
        >
          <Boundary>
            <MenuRenderer menus={menus} host={view} revision={projection.revision} />
          </Boundary>
        </Show>,
        menus.catalogMenuView.render(CatalogMenu),
      ];
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
      const active = () => isSidebarRouteActive(view.activeRouteId, routeId);
      const opensSection =
        routeId === "cron" ||
        routeId === "plugins" ||
        routeId === "systems" ||
        routeId === "workboard";
      const link = (
        <SidebarNavLink
          ref={triggerRef}
          icon={<Icon name={navigationIconForRoute(routeId)} filled={active()} />}
          label={titleForRoute(routeId, t)}
          href={sessionTarget()?.href ?? pathForRoute(routeId, view.basePath)}
          active={active()}
          onNavigate={() =>
            opensSection
              ? view.onNavigate?.(routeId, undefined, "sidebar-section")
              : view.onNavigate?.(routeId, sessionTarget()?.options)
          }
        />
      );
      return <Show when={view.enabledRouteIds?.includes(routeId) ?? true}>{link}</Show>;
    },
  });
  return menus;
}
