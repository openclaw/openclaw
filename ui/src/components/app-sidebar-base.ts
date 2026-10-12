import type { ReactiveController } from "lit";
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
import { SESSION_NAVIGATION_KEY_PARAM } from "../lib/sessions/route-navigation.ts";
import { parseAgentSessionKey, resolveUiConfiguredMainKey } from "../lib/sessions/session-key.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import type { SessionOwnerFilterController } from "./session-owner-filter-controller.ts";
import type { ContextualSidebar } from "./sidebar-context-state.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

export type AppSidebarProps = {
  basePath: string;
  activeRouteId: NavigationRouteId | undefined;
  router: Pick<ApplicationRouter, "getState" | "subscribeSelector"> | undefined;
  activePluginTabId: string;
  enabledRouteIds: readonly NavigationRouteId[] | undefined;
  connected: boolean;
  connectionStatus: GatewayStatus | null;
  lastError: string | null;
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
  lastError: { default: null, attribute: false },
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

/** Synchronous sidebar state and controller lifecycle; Solid owns its DOM. */
export abstract class AppSidebarBase {
  declare basePath: AppSidebarProps["basePath"];
  declare activeRouteId: AppSidebarProps["activeRouteId"];
  declare router: AppSidebarProps["router"];
  declare activePluginTabId: AppSidebarProps["activePluginTabId"];
  declare enabledRouteIds: AppSidebarProps["enabledRouteIds"];
  declare connected: AppSidebarProps["connected"];
  declare connectionStatus: AppSidebarProps["connectionStatus"];
  declare lastError: AppSidebarProps["lastError"];
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
  declare readonly ownerDocument: HTMLElement["ownerDocument"];
  declare readonly classList: HTMLElement["classList"];
  declare readonly querySelector: HTMLElement["querySelector"];
  declare readonly querySelectorAll: HTMLElement["querySelectorAll"];
  declare readonly addEventListener: HTMLElement["addEventListener"];
  declare readonly removeEventListener: HTMLElement["removeEventListener"];
  declare readonly contains: HTMLElement["contains"];
  declare readonly matches: HTMLElement["matches"];

  private readonly controllers = new Set<ReactiveController>();
  private readonly listeners = new Set<() => void>();
  private attached = false;
  private complete: Promise<boolean> = Promise.resolve(true);
  private finishUpdate: ((value: boolean) => void) | undefined;
  contextualSidebar: ContextualSidebar | undefined;
  sidebarSnapshot: SidebarSnapshotModel | null = null;
  sidebarPluginSnapshot: Pick<SidebarSnapshotModel, "entries" | "plugins"> | null = null;

  constructor(
    private props: AppSidebarProps,
    protected context: ApplicationContext,
    readonly hostElement: HTMLElement,
  ) {
    for (const key of Object.keys(appSidebarProperties)) {
      Object.defineProperty(this, key, {
        get: () =>
          key === "sidebarAgentsMode"
            ? (this.sidebarSnapshot?.mode ?? Reflect.get(this.props, key))
            : Reflect.get(this.props, key),
        set: (value: unknown) => {
          Reflect.set(hostElement, key, value);
        },
      });
    }
    for (const key of [
      "ownerDocument",
      "classList",
      "querySelector",
      "querySelectorAll",
      "addEventListener",
      "removeEventListener",
      "contains",
      "matches",
    ] as const) {
      const value = hostElement[key];
      Object.defineProperty(this, key, {
        value: typeof value === "function" ? value.bind(hostElement) : value,
      });
    }
  }

  bindInputs(props: AppSidebarProps, context: ApplicationContext): void {
    this.props = props;
    this.context = context;
    this.requestUpdate();
  }

  attach(): void {
    this.attached = true;
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
    this.connectedCallback();
    this.requestUpdate();
  }
  detach(): void {
    this.attached = false;
    this.disconnectedCallback();
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
    this.finishUpdate?.(false);
    this.finishUpdate = undefined;
  }
  get isConnected(): boolean {
    // The bridge delays disposal across moves; detached hosts cannot admit new work.
    return this.attached && this.hostElement.isConnected;
  }
  addController(controller: ReactiveController): void {
    this.controllers.add(controller);
    if (this.isConnected) {
      controller.hostConnected?.();
    }
  }
  removeController(controller: ReactiveController): void {
    this.controllers.delete(controller);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  requestUpdate(): void {
    if (!this.finishUpdate) {
      this.complete = new Promise((resolve) => {
        this.finishUpdate = resolve;
      });
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
  get updateComplete(): Promise<boolean> {
    return this.complete;
  }
  prepareRender(): void {
    if (!this.isConnected) {
      return;
    }
    this.willUpdate();
    for (const controller of this.controllers) {
      controller.hostUpdate?.();
    }
  }
  commitRender(): void {
    if (!this.isConnected) {
      return;
    }
    const finish = this.finishUpdate;
    this.finishUpdate = undefined;
    for (const controller of this.controllers) {
      controller.hostUpdated?.();
    }
    this.updated();
    finish?.(true);
  }
  protected connectedCallback(): void {}
  protected disconnectedCallback(): void {}
  protected willUpdate(): void {}
  protected updated(): void {}

  get sessionInvolvingMeFilterActive(): boolean {
    return this.sidebarSnapshot?.involvingMe ?? this.sessionOwnerFilter.involvingMe;
  }

  abstract readonly sessionOwnerFilter: SessionOwnerFilterController;

  setSessionOwnerFilter = (ownerId: string | null, involvingMe = false) => {
    this.sessionOwnerFilter.set(ownerId, involvingMe);
  };

  pluginNavigation() {
    return this.context?.plugins?.registrations("navigation") ?? [];
  }

  protected setApplicationSession(sessionKey: string, fallbackAgentId?: string): void {
    const context = this.context;
    if (!context) {
      return;
    }
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey,
      agentId: parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId,
    });
  }

  prepareSessionNavigation(sessionKey: string, pathname: string): void {
    if (this.context) {
      prepareSessionNavigationHandoff(this.context.gateway, pathname, sessionKey);
    }
  }

  protected bindLiteralSession(
    sessionKey: string,
    fallbackAgentId: string,
    options: ApplicationNavigationOptions,
  ): void {
    if (!new URLSearchParams(options.search ?? "").has(SESSION_NAVIGATION_KEY_PARAM)) {
      this.setApplicationSession(sessionKey, fallbackAgentId);
    }
  }

  protected sessionMainKey(): string {
    return resolveUiConfiguredMainKey({
      agentsList: this.context?.agents.state.agentsList,
      hello: this.context?.gateway.snapshot.hello,
    });
  }

  readNewSessionAccess(): SessionMethodAccess {
    return readSessionMethodAccess(
      this.connected && !this.sidebarSnapshot ? this.context?.gateway.snapshot : null,
      {
        method: "sessions.create",
        params: {},
        sessionScope: true,
      },
    );
  }

  readSessionMutationAccess(request: SessionMethodAccessRequest): SessionMethodAccess {
    return readSessionMethodAccess(
      this.connected && !this.sidebarSnapshot ? this.context?.gateway.snapshot : null,
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
