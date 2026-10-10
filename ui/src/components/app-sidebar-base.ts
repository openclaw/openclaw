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
import type { ContextualSidebar } from "./sidebar-context-state.ts";

export type AppSidebarProps = {
  basePath?: string;
  activeRouteId?: NavigationRouteId | undefined;
  router?: Pick<ApplicationRouter, "getState" | "subscribeSelector"> | undefined;
  activePluginTabId?: string;
  enabledRouteIds?: readonly NavigationRouteId[] | undefined;
  connected?: boolean;
  connectionStatus?: GatewayStatus | null;
  lastError?: string | null;
  storedOutboxes?: SidebarOutboxSummary | undefined;
  terminalAvailable?: boolean;
  catalogOpenTarget?: CatalogOpenTarget;
  canPairDevice?: boolean;
  preferencesBrowserOnly?: boolean;
  sessionKey?: string;
  sidebarEntries?: readonly string[];
  navigationVisible?: boolean;
  sidebarAgentsMode?: "chip" | "roster";
  sidebarLiveActivity?: boolean;
  pinnedAgentIds?: readonly string[];
  themeMode?: ThemeMode;
  gatewayVersion?: string | null;
  devGitBranch?: string | null;
  watchUpdateProgress?: ((listener: (progress: UpdateProgress) => void) => () => void) | undefined;
  onOpenPalette?: (() => void) | undefined;
  onRetryConnect?: (() => void) | undefined;
  onToggleSidebar?: (() => void) | undefined;
  onOpenNewSession?: ((agentId: string, target?: NewSessionTarget) => void) | undefined;
  onUpdateSidebarEntries?: ((entries: string[]) => void) | undefined;
  onPairMobile?: (() => void) | undefined;
  onNavigate?:
    | ((routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void)
    | undefined;
  onPreloadRoute?: ((routeId: NavigationRouteId) => Promise<void>) | undefined;
};

/** Synchronous sidebar state and controller lifecycle; Solid owns its DOM. */
export abstract class AppSidebarBase {
  private readonly controllers = new Set<ReactiveController>();
  private readonly listeners = new Set<() => void>();
  private element: HTMLElement | undefined;
  private attached = false;
  private complete: Promise<boolean> = Promise.resolve(true);
  private finishUpdate: ((value: boolean) => void) | undefined;
  private contextualValue: ContextualSidebar | undefined;

  constructor(
    protected readonly props: AppSidebarProps,
    protected readonly context: ApplicationContext,
  ) {}

  get contextualSidebar() {
    return this.contextualValue;
  }
  set contextualSidebar(value: ContextualSidebar | undefined) {
    if (this.contextualValue === value) {
      return;
    }
    this.contextualValue = value;
    this.requestUpdate();
  }

  attach(element: HTMLElement): void {
    this.element = element;
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
    this.element = undefined;
  }

  addController(controller: ReactiveController): void {
    this.controllers.add(controller);
    if (this.attached) {
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
    if (!this.attached) {
      return;
    }
    this.willUpdate();
    for (const controller of this.controllers) {
      controller.hostUpdate?.();
    }
  }
  commitRender(): void {
    if (!this.attached) {
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

  get hostElement(): HTMLElement {
    return this.element!;
  }
  get isConnected(): boolean {
    return this.attached;
  }
  get ownerDocument(): Document {
    return this.hostElement.ownerDocument;
  }
  get classList(): DOMTokenList {
    return this.hostElement.classList;
  }
  querySelector<E extends Element = Element>(selector: string): E | null {
    return this.element?.querySelector<E>(selector) ?? null;
  }
  querySelectorAll<E extends Element = Element>(selector: string): NodeListOf<E> {
    return this.hostElement.querySelectorAll<E>(selector);
  }
  readonly addEventListener: HTMLElement["addEventListener"] = (type, listener, options) =>
    this.hostElement.addEventListener(type, listener, options);
  readonly removeEventListener: HTMLElement["removeEventListener"] = (type, listener, options) =>
    this.hostElement.removeEventListener(type, listener, options);
  contains(node: Node | null): boolean {
    return this.element?.contains(node) ?? false;
  }
  matches(selector: string): boolean {
    return this.element?.matches(selector) ?? false;
  }
  get basePath(): string {
    return this.props.basePath ?? "";
  }
  get activeRouteId(): NavigationRouteId | undefined {
    return this.props.activeRouteId ?? undefined;
  }
  get router(): Pick<ApplicationRouter, "getState" | "subscribeSelector"> | undefined {
    return this.props.router ?? undefined;
  }
  get activePluginTabId(): string {
    return this.props.activePluginTabId ?? "";
  }
  get enabledRouteIds(): readonly NavigationRouteId[] | undefined {
    return this.props.enabledRouteIds ?? undefined;
  }
  get connected(): boolean {
    return this.props.connected ?? false;
  }
  get connectionStatus(): GatewayStatus | null {
    return this.props.connectionStatus ?? null;
  }
  get lastError(): string | null {
    return this.props.lastError ?? null;
  }
  get storedOutboxes(): SidebarOutboxSummary | undefined {
    return this.props.storedOutboxes ?? undefined;
  }
  get terminalAvailable(): boolean {
    return this.props.terminalAvailable ?? false;
  }
  get catalogOpenTarget(): CatalogOpenTarget {
    return this.props.catalogOpenTarget ?? "viewer";
  }
  get canPairDevice(): boolean {
    return this.props.canPairDevice ?? false;
  }
  get preferencesBrowserOnly(): boolean {
    return this.props.preferencesBrowserOnly ?? false;
  }
  get sessionKey(): string {
    return this.props.sessionKey ?? "";
  }
  get sidebarEntries(): readonly string[] {
    return this.props.sidebarEntries ?? DEFAULT_SIDEBAR_ENTRIES;
  }
  get navigationVisible(): boolean {
    return this.props.navigationVisible ?? true;
  }
  get sidebarAgentsMode(): "chip" | "roster" {
    return this.props.sidebarAgentsMode ?? "chip";
  }
  get sidebarLiveActivity(): boolean {
    return this.props.sidebarLiveActivity ?? true;
  }
  get pinnedAgentIds(): readonly string[] {
    return this.props.pinnedAgentIds ?? [];
  }
  get themeMode(): ThemeMode {
    return this.props.themeMode ?? "system";
  }
  get gatewayVersion(): string | null {
    return this.props.gatewayVersion ?? null;
  }
  get devGitBranch(): string | null {
    return this.props.devGitBranch ?? null;
  }
  get watchUpdateProgress():
    | ((listener: (progress: UpdateProgress) => void) => () => void)
    | undefined {
    return this.props.watchUpdateProgress ?? undefined;
  }
  get onOpenPalette(): (() => void) | undefined {
    return this.props.onOpenPalette ?? undefined;
  }
  get onRetryConnect(): (() => void) | undefined {
    return this.props.onRetryConnect ?? undefined;
  }
  get onToggleSidebar(): (() => void) | undefined {
    return this.props.onToggleSidebar ?? undefined;
  }
  get onOpenNewSession(): ((agentId: string, target?: NewSessionTarget) => void) | undefined {
    return this.props.onOpenNewSession ?? undefined;
  }
  get onUpdateSidebarEntries(): ((entries: string[]) => void) | undefined {
    return this.props.onUpdateSidebarEntries ?? undefined;
  }
  get onPairMobile(): (() => void) | undefined {
    return this.props.onPairMobile ?? undefined;
  }
  get onNavigate():
    | ((routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void)
    | undefined {
    return this.props.onNavigate ?? undefined;
  }
  get onPreloadRoute(): ((routeId: NavigationRouteId) => Promise<void>) | undefined {
    return this.props.onPreloadRoute ?? undefined;
  }

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
    return readSessionMethodAccess(this.connected ? this.context?.gateway.snapshot : null, {
      method: "sessions.create",
      params: {},
      sessionScope: true,
    });
  }

  readSessionMutationAccess(request: SessionMethodAccessRequest): SessionMethodAccess {
    return readSessionMethodAccess(this.connected ? this.context?.gateway.snapshot : null, request);
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
