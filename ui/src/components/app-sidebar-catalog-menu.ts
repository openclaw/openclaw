// Owns catalog-row menu state, actions, focus anchor, and rendering for AppSidebar.
import { html, nothing } from "lit";
import { pathForRoute } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { parseCatalogSessionKey, type CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import { showToast } from "../lib/toast.ts";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import type { SidebarCatalogSessionMutationScope } from "./app-sidebar-session-types.ts";
import type { CatalogSessionMenuAction } from "./catalog-session-menu.ts";
import "./catalog-session-menu.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import { SESSION_MENU_OPEN_EVENT } from "./session-progress-hovercard-target.ts";
import type { SidebarMenusControllerHost } from "./sidebar-menus-controller-types.ts";

type SidebarCatalogSessionMenuState = CatalogSessionMenuRequest & { x: number; y: number };

type SidebarCatalogMenuHost = Pick<
  SidebarMenusControllerHost,
  | "activeRouteId"
  | "basePath"
  | "getRouteSessionKey"
  | "onNavigate"
  | "requestUpdate"
  | "sessionDataContext"
  | "terminalAvailable"
> & {
  sessionData: Pick<
    SidebarMenusControllerHost["sessionData"],
    | "beginSessionMutation"
    | "isSessionMutationScopeCurrent"
    | "archiveSessionCatalog"
    | "sessionScopeGeneration"
  >;
};

export class SidebarCatalogMenuController {
  private state: SidebarCatalogSessionMenuState | null = null;
  private trigger: HTMLElement | null = null;

  constructor(
    private readonly host: SidebarCatalogMenuHost,
    private readonly beforeOpen: () => void,
  ) {}

  get isOpen(): boolean {
    return this.state !== null;
  }

  isOpenFor(key: CatalogSessionKey): boolean {
    const openKey = this.state?.key;
    return (
      openKey?.catalogId === key.catalogId &&
      openKey.hostId === key.hostId &&
      openKey.threadId === key.threadId &&
      openKey.sourceHomeId === key.sourceHomeId
    );
  }

  open(
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ): void {
    trigger?.dispatchEvent(
      new CustomEvent(SESSION_MENU_OPEN_EVENT, { bubbles: true, composed: true }),
    );
    this.beforeOpen();
    this.trigger = trigger;
    this.state = { ...request, x, y };
    this.host.requestUpdate();
  }

  close(): void {
    if (!this.state && !this.trigger) {
      return;
    }
    this.trigger = null;
    this.state = null;
    this.host.requestUpdate();
  }

  retargetTrigger(key: CatalogSessionKey, element: Element | undefined): void {
    if (!(element instanceof HTMLElement) || !this.isOpenFor(key)) {
      return;
    }
    // Catalog adoption replaces the trigger while popup focus is elsewhere.
    queueMicrotask(() => {
      if (element.isConnected && !this.trigger?.isConnected && this.isOpenFor(key)) {
        this.trigger = element;
        this.host.requestUpdate();
      }
    });
  }

  private handleAction(
    menu: SidebarCatalogSessionMenuState,
    action: CatalogSessionMenuAction,
  ): void {
    if (action === "terminal") {
      if (menu.canOpenTerminal && this.host.terminalAvailable) {
        openCatalogSessionInTerminal(this.host, menu.key, menu.agentId);
      }
      return;
    }
    if (action === "delete") {
      if (menu.canDelete) {
        void this.deleteSession(menu);
      }
      return;
    }
    this.host.onNavigate?.(menu.routeId, menu.navigation);
  }

  private isMutationCurrent(scope: SidebarCatalogSessionMutationScope): boolean {
    return (
      this.host.sessionData.isSessionMutationScopeCurrent(scope) &&
      scope.catalogGeneration === this.host.sessionData.sessionScopeGeneration
    );
  }

  private async deleteSession(menu: SidebarCatalogSessionMenuState): Promise<void> {
    const mutation = this.host.sessionData.beginSessionMutation();
    if (!mutation) {
      return;
    }
    const scope = { ...mutation, catalogGeneration: this.host.sessionData.sessionScopeGeneration };
    try {
      const confirmed = await showConfirmDialog({
        message: t("chat.catalog.deleteSessionConfirm"),
        details: menu.name,
        confirmLabel: t("chat.catalog.deleteSession"),
        danger: true,
        signal: scope.signal,
      });
      if (!this.isMutationCurrent(scope)) {
        showToast({
          message: t("sessionsView.deleteSessionStale", { session: menu.name }),
        });
        return;
      }
      if (!confirmed) {
        return;
      }
      await this.host.sessionData.archiveSessionCatalog(scope, {
        ...menu.key,
        agentId: menu.agentId,
        confirmNoOtherRunner: true,
      });
      if (!this.isMutationCurrent(scope)) {
        return;
      }
      const active = parseCatalogSessionKey(this.host.getRouteSessionKey());
      if (
        this.host.activeRouteId === "chat" &&
        active?.catalogId === menu.key.catalogId &&
        active.hostId === menu.key.hostId &&
        active.threadId === menu.key.threadId
      ) {
        this.host.onNavigate?.("chat", {
          pathname: pathForRoute("chat", this.host.basePath),
          search: "",
          hash: "",
        });
      }
    } catch (error) {
      showToast({ message: formatUiError(error) });
    }
  }

  render() {
    const menu = this.state;
    if (!menu) {
      return nothing;
    }
    return html`
      <openclaw-catalog-session-menu
        .x=${menu.x}
        .y=${menu.y}
        .trigger=${this.trigger}
        .lastActive=${menu.meta}
        .canDelete=${menu.canDelete}
        .terminalDisabled=${!menu.canOpenTerminal || !this.host.terminalAvailable}
        .onAction=${(action: CatalogSessionMenuAction) => this.handleAction(menu, action)}
        .onClose=${() => this.close()}
      ></openclaw-catalog-session-menu>
    `;
  }
}
