import { createChangeListeners } from "../../../src/shared/listeners.js";
import { DEFAULT_SIDEBAR_ENTRIES, type NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationRouter } from "../app-routes.ts";
import { selectApplicationSession } from "../app/agent-selection.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import type { CatalogOpenTarget } from "../app/settings.ts";
import type { ThemeMode } from "../app/theme.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import type { SidebarOutboxSummary } from "../lib/chat/outbox-store-projection.ts";
import type { GatewayStatus } from "../lib/gateway-status.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
  type SessionMethodAccessRequest,
} from "../lib/session-method-access.ts";
import { prepareSessionNavigationHandoff } from "../lib/sessions/navigation-handoff.ts";
import { parseAgentSessionKey, resolveUiConfiguredMainKey } from "../lib/sessions/session-key.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import type { GatewayStatusProps } from "./gateway-status.ts";
import type { SessionOwnerFilter } from "./session-owner-filter.ts";
import { selectSidebarContext, type ContextualSidebar } from "./sidebar-context-state.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

export type AppSidebarProps = {
  basePath: string;
  activeRouteId: NavigationRouteId | undefined;
  router: Pick<ApplicationRouter, "getState" | "subscribeSelector"> | undefined;
  activePluginTabId: string;
  enabledRouteIds: readonly NavigationRouteId[] | undefined;
  connected: boolean;
  connectionStatus: GatewayStatus | null;
  gatewayStatus: GatewayStatusProps | null;
  connectionRecovery: boolean;
  connectionFlagVisible: boolean;
  connectionFlagAllowed: boolean;
  footerControlsOverlap:
    | ((bounds: Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom">) => boolean)
    | undefined;
  storedOutboxes: SidebarOutboxSummary | undefined;
  terminalAvailable: boolean;
  catalogOpenTarget: CatalogOpenTarget;
  canPairDevice: boolean;
  sessionKey: string;
  sidebarEntries: readonly string[];
  navigationVisible: boolean;
  navigationView: "pages" | "sessions" | "online";
  navigationCollapsed: boolean;
  sidebarAgentsMode: "chip" | "roster";
  sidebarLiveActivity: boolean;
  pinnedAgentIds: readonly string[];
  themeMode: ThemeMode;
  gatewayVersion: string | null;
  devGitBranch: string | null;
  watchUpdateProgress: ((listener: (progress: UpdateProgress) => void) => () => void) | undefined;
  onOpenPalette: (() => void) | undefined;
  onRetryConnect: (() => void) | undefined;
  onToggleSidebar: (() => void) | undefined;
  onOpenNewSession: ((agentId: string, target?: NewSessionTarget) => void) | undefined;
  onUpdateSidebarEntries: ((entries: string[]) => void) | undefined;
  onPairMobile: (() => void) | undefined;
  onNavigate:
    | ((routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void)
    | undefined;
  onPreloadRoute: ((routeId: NavigationRouteId) => Promise<void>) | undefined;
};

export const appSidebarProperties = {
  basePath: { default: "", attribute: false },
  activeRouteId: { default: undefined, attribute: false },
  router: { default: undefined, attribute: false },
  activePluginTabId: { default: "", attribute: false },
  enabledRouteIds: { default: undefined, attribute: false },
  connected: { default: false, attribute: false },
  connectionStatus: { default: null, attribute: false },
  gatewayStatus: { default: null, attribute: false },
  connectionRecovery: { default: false, attribute: false },
  connectionFlagVisible: { default: false, attribute: false },
  connectionFlagAllowed: { default: false, attribute: false },
  footerControlsOverlap: { default: undefined, attribute: false },
  storedOutboxes: { default: undefined, attribute: false },
  terminalAvailable: { default: false, attribute: false },
  catalogOpenTarget: { default: "viewer", attribute: false },
  canPairDevice: { default: false, attribute: false },
  sessionKey: { default: "", attribute: false },
  sidebarEntries: { default: DEFAULT_SIDEBAR_ENTRIES, attribute: false },
  navigationVisible: { default: true, attribute: false },
  navigationView: { default: "sessions", attribute: false },
  navigationCollapsed: { default: false, type: Boolean },
  sidebarAgentsMode: { default: "chip", attribute: false },
  sidebarLiveActivity: { default: true, attribute: false },
  pinnedAgentIds: { default: [], attribute: false },
  themeMode: { default: "system", attribute: false },
  gatewayVersion: { default: null, attribute: false },
  devGitBranch: { default: null, attribute: false },
  watchUpdateProgress: { default: undefined, attribute: false },
  onOpenPalette: { default: undefined, attribute: false },
  onRetryConnect: { default: undefined, attribute: false },
  onToggleSidebar: { default: undefined, attribute: false },
  onOpenNewSession: { default: undefined, attribute: false },
  onUpdateSidebarEntries: { default: undefined, attribute: false },
  onPairMobile: { default: undefined, attribute: false },
  onNavigate: { default: undefined, attribute: false },
  onPreloadRoute: { default: undefined, attribute: false },
} satisfies {
  [Key in keyof AppSidebarProps]: {
    default: AppSidebarProps[Key];
    attribute?: false;
    type?: BooleanConstructor;
  };
};

/** Synchronous sidebar state and native attachment; Solid owns its DOM. */
export abstract class AppSidebarBase {
  declare basePath: AppSidebarProps["basePath"];
  declare activeRouteId: AppSidebarProps["activeRouteId"];
  declare router: AppSidebarProps["router"];
  declare activePluginTabId: AppSidebarProps["activePluginTabId"];
  declare enabledRouteIds: AppSidebarProps["enabledRouteIds"];
  declare connected: AppSidebarProps["connected"];
  declare connectionStatus: AppSidebarProps["connectionStatus"];
  declare gatewayStatus: AppSidebarProps["gatewayStatus"];
  declare connectionRecovery: AppSidebarProps["connectionRecovery"];
  declare connectionFlagVisible: AppSidebarProps["connectionFlagVisible"];
  declare connectionFlagAllowed: AppSidebarProps["connectionFlagAllowed"];
  declare footerControlsOverlap: AppSidebarProps["footerControlsOverlap"];
  declare storedOutboxes: AppSidebarProps["storedOutboxes"];
  declare terminalAvailable: AppSidebarProps["terminalAvailable"];
  declare catalogOpenTarget: AppSidebarProps["catalogOpenTarget"];
  declare canPairDevice: AppSidebarProps["canPairDevice"];
  declare sessionKey: AppSidebarProps["sessionKey"];
  declare sidebarEntries: AppSidebarProps["sidebarEntries"];
  declare navigationVisible: AppSidebarProps["navigationVisible"];
  declare navigationView: AppSidebarProps["navigationView"];
  declare navigationCollapsed: AppSidebarProps["navigationCollapsed"];
  declare sidebarAgentsMode: AppSidebarProps["sidebarAgentsMode"];
  declare sidebarLiveActivity: AppSidebarProps["sidebarLiveActivity"];
  declare pinnedAgentIds: AppSidebarProps["pinnedAgentIds"];
  declare themeMode: AppSidebarProps["themeMode"];
  declare gatewayVersion: AppSidebarProps["gatewayVersion"];
  declare devGitBranch: AppSidebarProps["devGitBranch"];
  declare watchUpdateProgress: AppSidebarProps["watchUpdateProgress"];
  declare onOpenPalette: AppSidebarProps["onOpenPalette"];
  declare onRetryConnect: AppSidebarProps["onRetryConnect"];
  declare onToggleSidebar: AppSidebarProps["onToggleSidebar"];
  declare onOpenNewSession: AppSidebarProps["onOpenNewSession"];
  declare onUpdateSidebarEntries: AppSidebarProps["onUpdateSidebarEntries"];
  declare onPairMobile: AppSidebarProps["onPairMobile"];
  declare onNavigate: AppSidebarProps["onNavigate"];
  declare onPreloadRoute: AppSidebarProps["onPreloadRoute"];
  get ownerDocument(): Document {
    return this.hostElement.ownerDocument;
  }

  readonly navigationViewElements = new Map<AppSidebarProps["navigationView"], HTMLElement>();

  activeNavigationViewElement(): HTMLElement | undefined {
    if (!this.navigationVisible || this.navigationCollapsed) {
      return undefined;
    }
    const element = this.navigationViewElements.get(this.navigationView);
    return element?.isConnected ? element : undefined;
  }

  private readonly listeners = createChangeListeners();
  private attached = false;
  private complete: Promise<boolean> = Promise.resolve(true);
  private finishUpdate: ((value: boolean) => void) | undefined;
  get contextualSidebar(): ContextualSidebar | undefined {
    return this.isConnected && this.router
      ? selectSidebarContext(this.router.getState())
      : undefined;
  }

  sidebarSnapshot: SidebarSnapshotModel | null = null;
  sidebarPluginSnapshot: Pick<SidebarSnapshotModel, "entries" | "plugins"> | null = null;

  constructor(
    protected context: ApplicationContext,
    readonly hostElement: HTMLElement & AppSidebarProps,
  ) {
    for (const key of Object.keys(appSidebarProperties)) {
      Object.defineProperty(this, key, {
        get: () =>
          key === "sidebarAgentsMode"
            ? (this.sidebarSnapshot?.mode ?? Reflect.get(hostElement, key))
            : Reflect.get(hostElement, key),
        set: (value: unknown) => {
          Reflect.set(hostElement, key, value);
        },
      });
    }
  }

  bindContext(context: ApplicationContext): void {
    this.context = context;
    this.invalidate();
  }

  attach(): void {
    if (this.attached) {
      return;
    }
    this.attached = true;
    this.connectedCallback();
    this.invalidate();
  }
  detach(): void {
    if (!this.attached) {
      return;
    }
    this.attached = false;
    this.disconnectedCallback();
    this.finishUpdate?.(false);
    this.finishUpdate = undefined;
  }
  get isConnected(): boolean {
    // The bridge delays disposal across moves; detached hosts cannot admit new work.
    return this.attached && this.hostElement.isConnected;
  }
  readonly subscribe = this.listeners.subscribe;
  invalidate(): void {
    if (!this.finishUpdate) {
      this.complete = new Promise((resolve) => {
        this.finishUpdate = resolve;
      });
    }
    this.listeners.publish();
  }
  get updateComplete(): Promise<boolean> {
    return this.complete;
  }
  prepareRender(): void {
    if (!this.isConnected) {
      return;
    }
    this.willUpdate();
  }
  commitRender(): void {
    if (!this.isConnected) {
      return;
    }
    const finish = this.finishUpdate;
    this.finishUpdate = undefined;
    this.updated();
    finish?.(true);
  }
  protected connectedCallback(): void {}
  protected disconnectedCallback(): void {}
  protected willUpdate(): void {}
  protected updated(): void {}

  get sessionInvolvingMeFilterActive(): boolean {
    return this.sidebarSnapshot?.involvingMe ?? this.sessionOwnerFilter.read().involvingMe;
  }

  get sessionCatalogRowsVisible(): boolean {
    return (
      this.navigationView === "sessions" &&
      this.sidebarAgentsMode === "chip" &&
      !this.contextualSidebar
    );
  }

  abstract readonly sessionOwnerFilter: SessionOwnerFilter;

  setSessionOwnerFilter = (ownerId: string | null, involvingMe = false) => {
    this.sessionOwnerFilter.set(ownerId, involvingMe);
  };

  pluginNavigation() {
    return this.context.plugins.registrations("navigation");
  }

  pendingSessionCreate() {
    const pending = this.context.chatSubmissions.readCreate();
    return this.activeRouteId === "chat" && !pending?.creation.admitted ? pending : undefined;
  }

  public getRouteSessionKey(): string {
    // A provisional row owns only presentation, never the saved Gateway selection.
    return (
      this.pendingSessionCreate()?.creation.sessionKey ||
      this.sessionKey.trim() ||
      this.context.gateway.snapshot.sessionKey.trim()
    );
  }

  protected setApplicationSession(sessionKey: string, fallbackAgentId?: string): void {
    const context = this.context;
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey,
      agentId: parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId,
    });
  }

  prepareSessionNavigation(sessionKey: string, pathname: string): void {
    prepareSessionNavigationHandoff(this.context.gateway, pathname, sessionKey);
  }

  protected sessionMainKey(): string {
    return resolveUiConfiguredMainKey({
      agentsList: this.context.agents.state.agentsList,
      hello: this.context.gateway.snapshot.hello,
    });
  }

  readNewSessionAccess(): SessionMethodAccess {
    return this.readSessionMutationAccess({
      method: "sessions.create",
      params: {},
      sessionScope: true,
    });
  }

  readSessionMutationAccess(request: SessionMethodAccessRequest): SessionMethodAccess {
    return readSessionMethodAccess(
      this.connected && !this.sidebarSnapshot ? this.context.gateway.snapshot : null,
      request,
    );
  }

  requestOpenNewSession(agentId: string, target?: NewSessionTarget): void {
    if (this.readNewSessionAccess().allowed) {
      if (target) {
        this.onOpenNewSession?.(agentId, target);
      } else {
        this.onOpenNewSession?.(agentId);
      }
    }
  }
}
