import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Owns catalog-row menu state, actions, focus anchor, and rendering for AppSidebar.
import { Show } from "solid-js";
import { pathForRoute } from "../app-route-paths.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { readSessionMethodScopeAccess } from "../lib/session-method-access.ts";
import { parseCatalogSessionKey, type CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { showToast } from "../lib/toast.ts";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import type { SidebarCatalogSessionMutationScope } from "./app-sidebar-session-types.ts";
import type { CatalogSessionMenu } from "./catalog-session-menu-solid.tsx";
import { showConfirmDialog } from "./confirm-dialog.ts";
import { SESSION_MENU_OPEN_EVENT } from "./session-progress-hovercard-target.ts";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";

type SidebarCatalogSessionMenuState = CatalogSessionMenuRequest & { x: number; y: number };

type SidebarCatalogMenuHost = Pick<
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

export function createSidebarCatalogMenu(host: SidebarCatalogMenuHost, beforeOpen: () => void) {
  let state: { menu: SidebarCatalogSessionMenuState; trigger: HTMLElement | null } | null = null;
  let notify: (() => void) | undefined;
  const publish = () => notify?.();
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

  function isMutationCurrent(scope: SidebarCatalogSessionMutationScope): boolean {
    return (
      host.sessionData.isSessionMutationScopeCurrent(scope) &&
      scope.catalogGeneration === host.sessionData.sessionScopeGeneration
    );
  }

  function canImport(current = host): boolean {
    const snapshot = current.sessionDataContext?.gateway.snapshot;
    return (
      snapshot?.phase === "connected" &&
      readSessionMethodScopeAccess(snapshot.hello?.auth, {
        method: "sessions.catalog.import",
        requiredScope: "operator.write",
      }).allowed
    );
  }

  async function importSession(menu: SidebarCatalogSessionMenuState): Promise<void> {
    const mutation = host.sessionData.beginSessionMutation();
    if (!mutation) {
      return;
    }
    const scope = { ...mutation, catalogGeneration: host.sessionData.sessionScopeGeneration };
    const displayName = truncateUtf16Safe(menu.displayName?.trim() ?? "", 500);
    try {
      const result = await host.sessionData.importSessionCatalog(scope, {
        ...menu.key,
        agentId: menu.agentId,
        ...(displayName ? { displayName } : {}),
      });
      if (!result || !isMutationCurrent(scope)) {
        return;
      }
      showToast({
        message: t(
          !result.complete
            ? "chat.catalog.importIncomplete"
            : result.importedItems === 0
              ? "chat.catalog.importUnchanged"
              : "chat.catalog.importComplete",
          { count: String(result.importedItems) },
        ),
        actionLabel: t("chat.catalog.openImportedSession"),
        onAction: () => {
          if (!isMutationCurrent(scope)) {
            return;
          }
          const target = sessionNavigationTarget({
            context: scope.context,
            face: "chat",
            sessionKey: result.sessionKey,
            agentId: menu.agentId,
            exactKey: true,
          });
          host.onNavigate?.("chat", { ...target.options, search: "", hash: "" });
        },
      });
    } catch (error) {
      if (isMutationCurrent(scope)) {
        showToast({ message: formatUiError(error) });
      }
    }
  }

  async function deleteSession(menu: SidebarCatalogSessionMenuState): Promise<void> {
    const mutation = host.sessionData.beginSessionMutation();
    if (!mutation) {
      return;
    }
    const scope = { ...mutation, catalogGeneration: host.sessionData.sessionScopeGeneration };
    try {
      const confirmed = await showConfirmDialog({
        message: t("chat.catalog.deleteSessionConfirm"),
        details: menu.name,
        confirmLabel: t("chat.catalog.deleteSession"),
        danger: true,
        signal: scope.signal,
      });
      if (!isMutationCurrent(scope)) {
        showToast({
          message: t("sessionsView.deleteSessionStale", { session: menu.name }),
        });
        return;
      }
      if (!confirmed) {
        return;
      }
      await host.sessionData.archiveSessionCatalog(scope, {
        ...menu.key,
        agentId: menu.agentId,
        confirmNoOtherRunner: true,
      });
      if (!isMutationCurrent(scope)) {
        return;
      }
      const active = parseCatalogSessionKey(host.getRouteSessionKey());
      if (
        host.activeRouteId === "chat" &&
        active?.catalogId === menu.key.catalogId &&
        active.hostId === menu.key.hostId &&
        active.threadId === menu.key.threadId &&
        active.sourceHomeId === menu.key.sourceHomeId
      ) {
        host.onNavigate?.("chat", {
          pathname: pathForRoute("chat", host.basePath),
          search: "",
          hash: "",
        });
      }
    } catch (error) {
      showToast({ message: formatUiError(error) });
    }
  }

  return {
    isOpen: () => state !== null,
    isOpenFor,
    open,
    close,
    retargetTrigger,
    createView(viewHost: SidebarCatalogMenuHost) {
      const snapshot = projectSource(null, {
        read: () => state,
        subscribe: (_, listener) => {
          notify = listener;
          return () => (notify = undefined);
        },
        equality: "revision",
      });
      return {
        isOpenFor: (key: CatalogSessionKey) => matchesMenu(snapshot.read()?.menu, key),
        render: (CatalogMenu: typeof CatalogSessionMenu) => (
          <Show when={snapshot.read()?.menu} keyed>
            {(menu) => (
              <CatalogMenu
                x={menu.x}
                y={menu.y}
                trigger={snapshot.read()?.trigger ?? null}
                lastActive={menu.meta}
                canDelete={menu.canDelete}
                canImport={canImport(viewHost)}
                terminalDisabled={!menu.canOpenTerminal || !viewHost.terminalAvailable}
                onAction={(action) => {
                  if (action === "import") {
                    if (canImport()) {
                      void importSession(menu);
                    }
                    return;
                  }
                  if (action === "terminal") {
                    if (menu.canOpenTerminal && host.terminalAvailable) {
                      openCatalogSessionInTerminal(host, menu.key, menu.agentId);
                    }
                    return;
                  }
                  if (action === "delete") {
                    if (menu.canDelete) {
                      void deleteSession(menu);
                    }
                    return;
                  }
                  host.onNavigate?.(menu.routeId, menu.navigation);
                }}
                onClose={close}
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
