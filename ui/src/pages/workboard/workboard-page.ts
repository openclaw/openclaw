import { consume } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { isPluginEnabledInConfigSnapshot } from "../../lib/plugin-activation.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import {
  configureWorkboardPolling,
  getWorkboardState,
  loadWorkboard,
  stopWorkboardLifecycleRefresh,
  stopWorkboardPolling,
  syncWorkboardLifecycle,
} from "../../lib/workboard/index.ts";
import { renderWorkboard } from "./view.ts";

export class WorkboardPage extends LitElement {
  createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext;

  private stopAgentsSubscription?: () => void;
  private stopConfigSubscription?: () => void;
  private stopGatewaySubscription?: () => void;
  private stopSessionsSubscription?: () => void;

  private readonly requestPageUpdate = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    this.ensureSubscriptions();
    this.ensureInitialData();
    this.syncWorkboardRuntime();
  }

  override updated() {
    this.ensureSubscriptions();
    this.syncWorkboardRuntime();
  }

  override disconnectedCallback() {
    this.stopAgentsSubscription?.();
    this.stopAgentsSubscription = undefined;
    this.stopConfigSubscription?.();
    this.stopConfigSubscription = undefined;
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopSessionsSubscription?.();
    this.stopSessionsSubscription = undefined;
    stopWorkboardPolling(this);
    stopWorkboardLifecycleRefresh(this);
    super.disconnectedCallback();
  }

  private ensureSubscriptions() {
    const context = this.context;
    if (!context || this.stopGatewaySubscription) {
      return;
    }
    this.stopAgentsSubscription = context.agents.subscribe(() => {
      this.requestUpdate();
    });
    this.stopConfigSubscription = context.runtimeConfig.subscribe(() => {
      this.requestUpdate();
      this.ensureInitialData();
    });
    this.stopSessionsSubscription = context.sessions.subscribe(() => {
      this.requestUpdate();
    });
    this.stopGatewaySubscription = context.gateway.subscribe((snapshot) => {
      if (snapshot.connected && snapshot.client) {
        this.ensureInitialData();
      }
      this.requestUpdate();
    });
  }

  private ensureInitialData() {
    const context = this.context;
    const gateway = context?.gateway.snapshot;
    if (!context || !gateway?.connected || !gateway.client) {
      return;
    }
    if (!context.runtimeConfig.state.configSnapshot && !context.runtimeConfig.state.configLoading) {
      void context.runtimeConfig.ensureLoaded();
    }
    if (!context.agents.state.agentsList && !context.agents.state.agentsLoading) {
      void context.agents.ensureList();
    }
    if (!context.sessions.state.result && !context.sessions.state.loading) {
      void context.sessions.refresh();
    }
  }

  private pluginEnabled(): boolean | null {
    const snapshot = this.context?.runtimeConfig.state.configSnapshot;
    return snapshot
      ? isPluginEnabledInConfigSnapshot(snapshot, "workboard", { enabledByDefault: false })
      : null;
  }

  private syncWorkboardRuntime() {
    const context = this.context;
    const gateway = context?.gateway.snapshot;
    const pluginEnabled = this.pluginEnabled();
    if (!context || !gateway?.connected || !gateway.client || pluginEnabled !== true) {
      stopWorkboardPolling(this);
      stopWorkboardLifecycleRefresh(this);
      return;
    }
    const state = getWorkboardState(this);
    configureWorkboardPolling({
      host: this,
      client: gateway.client,
      enabled: state.autoRefreshIntervalMs > 0,
      requestUpdate: this.requestPageUpdate,
    });
    void loadWorkboard({
      host: this,
      client: gateway.client,
      requestUpdate: this.requestPageUpdate,
      refreshDiagnostics: hasOperatorWriteAccess(gateway.hello?.auth ?? null),
    });
    if (!state.pollRefreshInProgress && !state.dispatching) {
      void syncWorkboardLifecycle({
        host: this,
        client: gateway.client,
        sessions: context.sessions.state.result?.sessions ?? [],
        canWrite: hasOperatorWriteAccess(gateway.hello?.auth ?? null),
        requestUpdate: this.requestPageUpdate,
      });
    }
  }

  private reloadConfig() {
    const context = this.context;
    if (!context) {
      return;
    }
    void context.runtimeConfig.refresh({ discardPendingChanges: true });
  }

  override render() {
    const context = this.context;
    if (!context) {
      return nothing;
    }
    const gateway = context.gateway.snapshot;
    const config = context.runtimeConfig.state;
    const auth = gateway.hello?.auth ?? null;
    const pluginEnabled = this.pluginEnabled();
    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("workboard")}</div>
          <div class="page-sub">${subtitleForRoute("workboard")}</div>
        </div>
      </section>
      ${renderWorkboard({
        host: this,
        client: gateway.client,
        connected: gateway.connected,
        canWrite: hasOperatorWriteAccess(auth),
        canModelOverride: hasOperatorAdminAccess(auth),
        pluginEnabled,
        pluginEnablementError:
          !config.configSnapshot && !config.configLoading ? config.lastError : null,
        agentsList: context.agents.state.agentsList,
        sessions: context.sessions.state.result?.sessions ?? [],
        onOpenSession: (sessionKey) => {
          context.navigate("chat", { search: searchForSession(sessionKey) });
        },
        onReloadConfig: () => this.reloadConfig(),
        onRequestUpdate: this.requestPageUpdate,
      })}
    `;
  }
}

if (!customElements.get("openclaw-workboard-page")) {
  customElements.define("openclaw-workboard-page", WorkboardPage);
}
