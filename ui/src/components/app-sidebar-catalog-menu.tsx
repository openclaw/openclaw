// Owns catalog-row menu state and its focus anchor for AppSidebar.
import { Show, type Component } from "solid-js";
import { projectSource } from "../lib/reactive/projection.ts";
import type { CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import { SESSION_MENU_OPEN_EVENT } from "./session-progress-hovercard-target.ts";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";

export type SidebarCatalogSessionMenuState = CatalogSessionMenuRequest & { x: number; y: number };

export type SidebarCatalogMenuHost = Pick<
  SidebarMenusOwner,
  | "activeRouteId"
  | "basePath"
  | "getRouteSessionKey"
  | "onNavigate"
  | "sessionDataContext"
  | "terminalAvailable"
> & {
  sessionData: Pick<
    SidebarMenusOwner["sessionData"],
    | "beginSessionMutation"
    | "isSessionMutationScopeCurrent"
    | "archiveSessionCatalog"
    | "importSessionCatalog"
    | "sessionScopeGeneration"
  >;
};

export type SidebarCatalogMenuViewProps = {
  host: SidebarCatalogMenuHost;
  viewHost: SidebarCatalogMenuHost;
  menu: SidebarCatalogSessionMenuState;
  trigger: HTMLElement | null;
  close: () => void;
};

export function createSidebarCatalogMenu(host: SidebarCatalogMenuHost, beforeOpen: () => void) {
  let state: { menu: SidebarCatalogSessionMenuState; trigger: HTMLElement | null } | null = null;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((notify) => notify());
  const isOpenFor = (key: CatalogSessionKey) => matchesMenu(state?.menu, key);

  function open(
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ): void {
    trigger?.dispatchEvent(
      new CustomEvent(SESSION_MENU_OPEN_EVENT, { bubbles: true, composed: true }),
    );
    beforeOpen();
    state = { menu: { ...request, x, y }, trigger };
    publish();
  }

  function close(): void {
    if (state) {
      state = null;
      publish();
    }
  }

  function retargetTrigger(key: CatalogSessionKey, element: Element | undefined): void {
    if (!(element instanceof HTMLElement) || !isOpenFor(key)) {
      return;
    }
    // Catalog adoption replaces the trigger while popup focus is elsewhere.
    queueMicrotask(() => {
      if (state && element.isConnected && !state.trigger?.isConnected && isOpenFor(key)) {
        state.trigger = element;
        publish();
      }
    });
  }

  return {
    isOpen: () => state !== null,
    isOpenFor,
    open,
    close,
    retargetTrigger,
    createView(viewHost: SidebarCatalogMenuHost) {
      const snapshot = projectSource(listeners, {
        read: () => state,
        subscribe: (source, notify) => {
          source.add(notify);
          return () => source.delete(notify);
        },
        equality: "revision",
      });
      return {
        isOpenFor: (key: CatalogSessionKey) => matchesMenu(snapshot.read()?.menu, key),
        render: (CatalogMenu: Component<SidebarCatalogMenuViewProps>) => (
          <Show when={snapshot.read()?.menu} keyed>
            {(menu) => (
              <CatalogMenu
                host={host}
                viewHost={viewHost}
                menu={menu}
                trigger={snapshot.read()?.trigger ?? null}
                close={close}
              />
            )}
          </Show>
        ),
      };
    },
  };
}

function matchesMenu(menu: SidebarCatalogSessionMenuState | undefined, key: CatalogSessionKey) {
  const openKey = menu?.key;
  return (
    openKey?.catalogId === key.catalogId &&
    openKey.hostId === key.hostId &&
    openKey.threadId === key.threadId &&
    openKey.sourceHomeId === key.sourceHomeId
  );
}
