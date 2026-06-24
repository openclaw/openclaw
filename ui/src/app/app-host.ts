import { consume, ContextProvider } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import type { SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-routes.ts";
import "../components/app-sidebar.ts";
import "../components/app-topbar.ts";
import "../components/command-palette.ts";
import "../components/exec-approval.ts";
import "../components/gateway-url-confirmation.ts";
import "../components/login-gate.ts";
import "../components/update-banner.ts";
import { CommandPalette } from "../components/command-palette.ts";
import type { ThemeModeChangeDetail } from "../components/theme-mode-toggle.ts";
import {
  clearActiveFloatingTooltips,
  prepareActiveFloatingTooltipsForRender,
  promoteNativeTitleTooltip,
  refreshActiveFloatingTooltip,
  restoreNativeTitleTooltip,
} from "../lib/dom-tooltips.ts";
import { resolveAgentIdFromSessionKey } from "../lib/session-key.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { applicationContext, type ApplicationContext } from "./context.ts";
import type { ApplicationOverlaySnapshot } from "./overlays.ts";
import { type RouterOutletSelection } from "./router-outlet.ts";
import "./router-outlet.ts";

const ACTIVE_ROUTE_IDS = ["chat"] as const;

function resolveOnboardingMode(): boolean {
  const raw = new URLSearchParams(globalThis.location?.search ?? "").get("onboarding");
  return raw !== null && /^(?:1|true|yes|on)$/iu.test(raw.trim());
}

export class OpenClawApp extends LitElement {
  @state() private gatewayConnected = false;
  @state() private gatewayLastError: string | null = null;
  @state() private gatewayLastErrorCode: string | null = null;
  @state() private loginGatewayUrl = "";
  @state() private loginToken = "";
  @state() private loginPassword = "";
  @state() private loginShowGatewayToken = false;
  @state() private loginShowGatewayPassword = false;
  @state() private pendingGatewayUrl: string | null = null;
  @state() private onboarding = resolveOnboardingMode();

  private runtime: ApplicationRuntime | undefined;
  private context: ApplicationContext<RouteId> | undefined;
  private readonly contextProvider = new ContextProvider(this, {
    context: applicationContext,
  });
  private stopGatewaySubscription: (() => void) | undefined;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.runtime = bootstrapApplication();
    this.context = this.runtime.context;
    this.pendingGatewayUrl = this.runtime.pendingGatewayConnection?.gatewayUrl ?? null;
    this.contextProvider.setValue(this.context);
    this.loginGatewayUrl = this.context.gateway.connection.gatewayUrl;
    this.loginToken = this.context.gateway.connection.token;
    this.loginPassword = this.context.gateway.connection.password;
    this.updateGatewayStatus(this.context.gateway.snapshot);
    this.stopGatewaySubscription = this.context.gateway.subscribe((snapshot) => {
      this.updateGatewayStatus(snapshot);
    });
    void this.runtime.start().catch((error: unknown) => {
      console.error("[openclaw] application start failed", error);
    });
  }

  override disconnectedCallback() {
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.runtime?.stop();
    this.runtime = undefined;
    this.context = undefined;
    this.pendingGatewayUrl = null;
    super.disconnectedCallback();
  }

  private readonly updateGatewayStatus = (snapshot: {
    connected: boolean;
    lastError: string | null;
    lastErrorCode: string | null;
  }) => {
    this.gatewayConnected = snapshot.connected;
    this.gatewayLastError = snapshot.lastError;
    this.gatewayLastErrorCode = snapshot.lastErrorCode;
  };

  override render() {
    const context = this.context;
    const runtime = this.runtime;
    if (!context || !runtime) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    const gatewayUrlConfirmation = this.pendingGatewayUrl
      ? html`
          <openclaw-gateway-url-confirmation
            .props=${{
              pendingGatewayUrl: this.pendingGatewayUrl,
              onConfirm: () => {
                runtime.confirmPendingGatewayConnection();
                this.pendingGatewayUrl = null;
              },
              onCancel: () => {
                runtime.cancelPendingGatewayConnection();
                this.pendingGatewayUrl = null;
              },
            }}
          ></openclaw-gateway-url-confirmation>
        `
      : nothing;
    if (!this.gatewayConnected) {
      return html`
        <openclaw-login-gate
          .props=${{
            basePath: context.basePath,
            connected: this.gatewayConnected,
            lastError: this.gatewayLastError,
            lastErrorCode: this.gatewayLastErrorCode,
            hasToken: Boolean(this.loginToken.trim()),
            hasPassword: Boolean(this.loginPassword.trim()),
            gatewayUrl: this.loginGatewayUrl,
            token: this.loginToken,
            password: this.loginPassword,
            showGatewayToken: this.loginShowGatewayToken,
            showGatewayPassword: this.loginShowGatewayPassword,
            onGatewayUrlChange: (value: string) => {
              this.loginGatewayUrl = value;
            },
            onTokenChange: (value: string) => {
              this.loginToken = value;
            },
            onPasswordChange: (value: string) => {
              this.loginPassword = value;
            },
            onToggleGatewayToken: () => {
              this.loginShowGatewayToken = !this.loginShowGatewayToken;
            },
            onToggleGatewayPassword: () => {
              this.loginShowGatewayPassword = !this.loginShowGatewayPassword;
            },
            onConnect: () => {
              context.gateway.connect({
                gatewayUrl: this.loginGatewayUrl,
                token: this.loginToken,
                password: this.loginPassword,
              });
            },
          }}
        ></openclaw-login-gate>
        ${gatewayUrlConfirmation}
      `;
    }
    return html`
      ${gatewayUrlConfirmation}
      <openclaw-app-shell .runtime=${runtime} .onboarding=${this.onboarding}></openclaw-app-shell>
    `;
  }
}

class OpenClawShell extends LitElement {
  @property({ attribute: false }) runtime?: ApplicationRuntime;
  @property({ attribute: false }) onboarding = false;
  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext<RouteId>;

  @state() private navCollapsed = false;
  @state() private navGroupsCollapsed: Record<string, boolean> = {};
  @state() private recentSessionsCollapsed = false;
  @state() private navDrawerOpen = false;
  @state() private gatewayConnected = false;
  @state() private gatewayVersion = "";
  @state() private sessionsResult: SessionsListResult | null = null;
  @state() private sessionsLoading = false;
  @state() private routeSelection: RouterOutletSelection<RouteId, unknown, unknown> = {
    status: "idle",
    active: undefined,
    pending: undefined,
    showPending: false,
  };
  @state() private overlaySnapshot: ApplicationOverlaySnapshot = {
    updateAvailable: null,
    updateRunning: false,
    updateStatusBanner: null,
    approvalQueue: [],
    approvalBusy: false,
    approvalError: null,
  };
  @query("openclaw-command-palette") private commandPalette?: CommandPalette;

  private stopGatewaySubscription: (() => void) | undefined;
  private stopNavigationSubscription: (() => void) | undefined;
  private stopSessionsSubscription: (() => void) | undefined;
  private stopRouteSubscription: (() => void) | undefined;
  private stopOverlaySubscription: (() => void) | undefined;

  private readonly nativeTitleTooltipPointerOver = (event: PointerEvent) => {
    promoteNativeTitleTooltip(event.target, this, "pointer");
  };

  private readonly nativeTitleTooltipPointerOut = (event: PointerEvent) => {
    restoreNativeTitleTooltip(event.target, this, "pointer", event.relatedTarget);
  };

  private readonly nativeTitleTooltipFocusIn = (event: FocusEvent) => {
    promoteNativeTitleTooltip(event.target, this, "focus");
  };

  private readonly nativeTitleTooltipFocusOut = (event: FocusEvent) => {
    restoreNativeTitleTooltip(event.target, this, "focus", event.relatedTarget);
  };

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.startSubscriptions();
    this.addEventListener("pointerover", this.nativeTitleTooltipPointerOver);
    this.addEventListener("pointerout", this.nativeTitleTooltipPointerOut);
    this.addEventListener("focusin", this.nativeTitleTooltipFocusIn);
    this.addEventListener("focusout", this.nativeTitleTooltipFocusOut);
  }

  override updated() {
    this.startSubscriptions();
    refreshActiveFloatingTooltip(this);
  }

  private startSubscriptions() {
    const runtime = this.runtime;
    const context = this.context;
    if (
      !runtime ||
      !context ||
      this.stopGatewaySubscription ||
      this.stopNavigationSubscription ||
      this.stopSessionsSubscription ||
      this.stopRouteSubscription ||
      this.stopOverlaySubscription
    ) {
      return;
    }
    this.updateNavigationPreferences(context.navigation.snapshot);
    this.stopNavigationSubscription = context.navigation.subscribe((snapshot) => {
      this.updateNavigationPreferences(snapshot);
    });
    this.updateSessions(context.sessions.snapshot);
    this.stopSessionsSubscription = context.sessions.subscribe((snapshot) => {
      this.updateSessions(snapshot);
    });
    this.updateGatewayStatus(context.gateway.snapshot);
    this.stopGatewaySubscription = context.gateway.subscribe((snapshot) => {
      this.updateGatewayStatus(snapshot);
    });
    this.routeSelection = runtime.routeSnapshot.get();
    this.stopRouteSubscription = runtime.routeSnapshot.subscribe((selection) => {
      this.routeSelection = selection;
    });
    this.overlaySnapshot = context.overlays.snapshot;
    this.stopOverlaySubscription = context.overlays.subscribe((snapshot) => {
      this.overlaySnapshot = snapshot;
    });
  }

  protected override willUpdate() {
    prepareActiveFloatingTooltipsForRender(this);
  }

  override disconnectedCallback() {
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopNavigationSubscription?.();
    this.stopNavigationSubscription = undefined;
    this.stopSessionsSubscription?.();
    this.stopSessionsSubscription = undefined;
    this.stopRouteSubscription?.();
    this.stopRouteSubscription = undefined;
    this.stopOverlaySubscription?.();
    this.stopOverlaySubscription = undefined;
    this.removeEventListener("pointerover", this.nativeTitleTooltipPointerOver);
    this.removeEventListener("pointerout", this.nativeTitleTooltipPointerOut);
    this.removeEventListener("focusin", this.nativeTitleTooltipFocusIn);
    this.removeEventListener("focusout", this.nativeTitleTooltipFocusOut);
    clearActiveFloatingTooltips(this);
    super.disconnectedCallback();
  }

  private readonly handleThemeChange = (event: CustomEvent<ThemeModeChangeDetail>) => {
    const context = this.context;
    if (!context) return;
    context.theme.setMode(event.detail.mode, event.detail.element);
    this.requestUpdate();
  };

  private navigate(routeId: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    if (routeId === "chat") {
      const renderedMatch = this.routeSelection.pending ?? this.routeSelection.active;
      const sessionKey =
        new URLSearchParams(renderedMatch?.location.search).get("session")?.trim() ||
        context.gateway.snapshot.sessionKey.trim();
      if (sessionKey) {
        context.navigate(routeId, {
          search: `?session=${encodeURIComponent(sessionKey)}`,
        });
      }
    }
    this.navDrawerOpen = false;
  }

  private readonly openPalette = () => {
    this.commandPalette?.openPalette();
  };

  private readonly updateGatewayStatus = (snapshot: {
    connected: boolean;
    hello: ApplicationRuntime["context"]["gateway"]["snapshot"]["hello"];
  }) => {
    const version = snapshot.hello?.server?.version ?? "";
    if (snapshot.connected === this.gatewayConnected && version === this.gatewayVersion) {
      return;
    }
    this.gatewayConnected = snapshot.connected;
    this.gatewayVersion = version;
  };

  private readonly updateNavigationPreferences = (
    snapshot: ApplicationRuntime["context"]["navigation"]["snapshot"],
  ) => {
    this.navCollapsed = snapshot.navCollapsed;
    this.navGroupsCollapsed = snapshot.navGroupsCollapsed;
    this.recentSessionsCollapsed = snapshot.recentSessionsCollapsed;
  };

  private readonly updateSessions = (
    snapshot: ApplicationRuntime["context"]["sessions"]["snapshot"],
  ) => {
    this.sessionsResult = snapshot.result;
    this.sessionsLoading = snapshot.loading;
  };

  override render() {
    const context = this.context;
    const runtime = this.runtime;
    if (!context || !runtime) {
      return nothing;
    }
    const selection = this.routeSelection;
    const renderedMatch = selection.pending ?? selection.active;
    const activeRoute = (renderedMatch?.routeId ?? "chat") as RouteId;
    const routeSessionKey =
      activeRoute === "chat"
        ? new URLSearchParams(renderedMatch?.location.search).get("session")?.trim() ||
          context.gateway.snapshot.sessionKey
        : "";
    const agentLabel = routeSessionKey ? resolveAgentIdFromSessionKey(routeSessionKey) : "";
    return html`
      <openclaw-command-palette
        .onOpen=${undefined}
        .onNavigate=${(routeId: RouteId) => this.navigate(routeId)}
        .onSlashCommand=${(command: string) => {
          const search = new URLSearchParams();
          if (routeSessionKey) {
            search.set("session", routeSessionKey);
          }
          search.set("draft", command.endsWith(" ") ? command : `${command} `);
          context.navigate("chat", { search: `?${search.toString()}` });
        }}
      ></openclaw-command-palette>
      <div
        class="shell ${activeRoute === "chat" ? "shell--chat" : ""} ${this.navCollapsed
          ? "shell--nav-collapsed"
          : ""} ${this.navDrawerOpen ? "shell--nav-drawer-open" : ""} ${this.onboarding
          ? "shell--onboarding"
          : ""}"
        @theme-change=${this.handleThemeChange}
      >
        <button
          type="button"
          class="shell-nav-backdrop"
          aria-label="Close navigation"
          @click=${() => (this.navDrawerOpen = false)}
        ></button>
        <openclaw-app-topbar
          .routeId=${activeRoute}
          .basePath=${context.basePath}
          .agentLabel=${agentLabel}
          .overviewHref=${""}
          .searchDisabled=${false}
          .navDrawerOpen=${this.navDrawerOpen}
          .themeMode=${context.theme.mode}
          .onboarding=${this.onboarding}
          .onOpenPalette=${this.openPalette}
          .onToggleDrawer=${() => (this.navDrawerOpen = !this.navDrawerOpen)}
          .onNavigate=${(routeId: string) => this.navigate(routeId)}
        ></openclaw-app-topbar>
        <div class="shell-nav">
          <openclaw-app-sidebar
            .basePath=${context.basePath}
            .activeRouteId=${activeRoute}
            .enabledRouteIds=${ACTIVE_ROUTE_IDS}
            .routeLocation=${renderedMatch?.location}
            .collapsed=${this.navCollapsed}
            .connected=${this.gatewayConnected}
            .version=${this.gatewayVersion}
            .navGroupsCollapsed=${this.navGroupsCollapsed}
            .sessionsResult=${this.sessionsResult}
            .sessionsLoading=${this.sessionsLoading}
            .recentSessionsCollapsed=${this.recentSessionsCollapsed}
            .themeMode=${context.theme.mode}
            .onToggleCollapsed=${() => {
              if (this.navDrawerOpen) {
                this.navDrawerOpen = false;
                return;
              }
              context.navigation.update({
                navCollapsed: !context.navigation.snapshot.navCollapsed,
              });
            }}
            .onToggleGroup=${(label: string) => {
              const current = context.navigation.snapshot.navGroupsCollapsed[label] ?? false;
              context.navigation.update({
                navGroupsCollapsed: {
                  ...context.navigation.snapshot.navGroupsCollapsed,
                  [label]: !current,
                },
              });
            }}
            .onToggleRecentSessions=${() =>
              context.navigation.update({
                recentSessionsCollapsed: !context.navigation.snapshot.recentSessionsCollapsed,
              })}
            .onNavigate=${(routeId: string) => this.navigate(routeId)}
            .onPreloadRoute=${(routeId: string) =>
              routeId === "chat" ? context.preload(routeId) : Promise.resolve()}
          ></openclaw-app-sidebar>
        </div>
        <main class="content ${activeRoute === "chat" ? "content--chat" : ""}">
          <openclaw-update-banner
            .props=${{
              statusBanner: this.overlaySnapshot.updateStatusBanner,
              updateAvailable: this.overlaySnapshot.updateAvailable,
              updateRunning: this.overlaySnapshot.updateRunning,
              connected: this.gatewayConnected,
              onUpdate: () =>
                context.overlays.runUpdate(routeSessionKey || context.gateway.snapshot.sessionKey),
              onDismiss: () => context.overlays.dismissUpdate(),
            }}
          ></openclaw-update-banner>
          <openclaw-router-outlet
            .router=${runtime.router}
            .snapshot=${runtime.routeSnapshot}
            .retryContext=${context}
            .onNotFound=${() => context.replace("chat")}
          ></openclaw-router-outlet>
        </main>
        <openclaw-exec-approval
          .props=${{
            queue: this.overlaySnapshot.approvalQueue,
            busy: this.overlaySnapshot.approvalBusy,
            error: this.overlaySnapshot.approvalError,
            onDecision: (decision: Parameters<typeof context.overlays.decideApproval>[0]) =>
              context.overlays.decideApproval(decision),
          }}
        ></openclaw-exec-approval>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-app")) {
  customElements.define("openclaw-app", OpenClawApp);
}
if (!customElements.get("openclaw-app-shell")) {
  customElements.define("openclaw-app-shell", OpenClawShell);
}
