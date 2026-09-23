// Settings page owning this browser's Gateway connection draft (URL, credential,
// default session) and the live handshake summary.
import "../../styles/connection.css";
import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import {
  loadSettings,
  resolveGatewayCredentialsForUrlEdit,
  type UiSettings,
} from "../../app/settings.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { GatewayStatusSample } from "../../components/gateway-vitals.ts";
import { renderLearnMoreLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import type { SparklineSample } from "../../components/sparkline-tile.ts";
import { t } from "../../i18n/index.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { formatGatewayHost } from "../../lib/gateway-host.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import {
  CONNECTION_PING_SAMPLE_LIMIT,
  summarizeConnectionPing,
  type ConnectionPingSummary,
} from "./latency.ts";
import { isUnknownSystemInfoMethodError, supportsSystemInfo } from "./system-info.ts";
import { renderConnection } from "./view.ts";

const DIAGNOSTICS_POLL_INTERVAL_MS = 5_000;
const CONNECTION_DOCS_URL = "https://docs.openclaw.ai/gateway/remote";

export class ConnectionPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private settings: UiSettings = loadSettings();
  @state() private password = "";
  @state() private gatewaySecretVisible = false;
  @state() private systemInfo: SystemInfoResult | null = null;
  @state() private systemInfoUnavailable = false;
  @state() private systemInfoLoading = false;
  @state() private ping: ConnectionPingSummary | null = null;
  @state() private pingFailed = false;
  private pingSamples: SparklineSample[] = [];
  private pingRequest: AbortController | null = null;
  @state() private statusHistory: GatewayStatusSample[] = [];
  @state() private statusFailed = false;
  private systemInfoRequest: AbortController | null = null;

  private sessionKeyBaseline = "";
  private sessionGatewayUrl = "";
  @state() private sessionSaved = false;

  private readonly diagnosticsPolling = new PollController(
    this,
    DIAGNOSTICS_POLL_INTERVAL_MS,
    () => this.refreshDiagnostics(),
    false,
  );

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.systemInfoLoading = false;
      this.resetDiagnostics();
    },
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
    onPageActivation: () => this.syncDiagnosticsPolling(),
  });

  override disconnectedCallback() {
    this.resetDiagnostics();
    this.resetSensitiveUi();
    super.disconnectedCallback();
  }

  private resetSensitiveUi() {
    this.gatewaySecretVisible = false;
  }

  private handleGatewaySnapshot({
    snapshot,
    initial,
    sourceChanged,
    clientChanged,
  }: GatewayPageChange) {
    const wasSystemInfoUnavailable = this.systemInfoUnavailable;
    if (initial || sourceChanged || clientChanged) {
      this.resetDiagnostics();
      this.resetConnectionDraft();
      if (
        initial ||
        sourceChanged ||
        this.sessionGatewayUrl !== this.context.gateway.connection.gatewayUrl
      ) {
        this.resetSessionDraft();
      }
      this.systemInfo = null;
      this.systemInfoUnavailable = false;
    } else if (snapshot.phase !== "connected") {
      this.resetSensitiveUi();
      this.systemInfo = null;
    }
    if (snapshot.phase === "connected" && snapshot.hello) {
      this.systemInfoUnavailable = !supportsSystemInfo(snapshot.hello);
      if (this.systemInfoUnavailable) {
        this.gateway.invalidate();
        this.systemInfoRequest?.abort();
        this.systemInfoRequest = null;
        this.systemInfoLoading = false;
        this.systemInfo = null;
        this.statusFailed = true;
      }
    }
    if (this.settings.sessionKey === this.sessionKeyBaseline) {
      this.settings = { ...this.settings, sessionKey: snapshot.sessionKey };
    }
    this.sessionKeyBaseline = snapshot.sessionKey;
    this.syncDiagnosticsPolling();
    if (wasSystemInfoUnavailable && !this.systemInfoUnavailable) {
      void this.loadSystemInfo();
    }
  }

  private stopDiagnosticsPolling() {
    this.diagnosticsPolling.stop();
    this.pingRequest?.abort();
    this.pingRequest = null;
    this.systemInfoRequest?.abort();
    this.systemInfoRequest = null;
    this.systemInfoLoading = false;
  }

  private resetDiagnostics() {
    this.stopDiagnosticsPolling();
    this.pingSamples = [];
    this.ping = null;
    this.pingFailed = false;
    this.statusHistory = [];
    this.statusFailed = false;
  }

  private syncDiagnosticsPolling() {
    const snapshot = this.context.gateway.snapshot;
    if (
      !this.isConnected ||
      document.visibilityState === "hidden" ||
      snapshot.phase !== "connected" ||
      !snapshot.client
    ) {
      this.stopDiagnosticsPolling();
      return;
    }
    if (this.diagnosticsPolling.start()) {
      this.refreshDiagnostics();
    }
  }

  private refreshDiagnostics() {
    void this.measurePing();
    void this.loadSystemInfo();
  }

  private async measurePing() {
    const gatewaySource = this.gateway.gateway;
    const scope = this.gateway.capture();
    if (
      !gatewaySource ||
      gatewaySource !== this.context.gateway ||
      !scope ||
      this.pingRequest ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const request = new AbortController();
    this.pingRequest = request;
    const isCurrent = () =>
      this.pingRequest === request &&
      this.isConnected &&
      document.visibilityState !== "hidden" &&
      this.context.gateway === gatewaySource &&
      this.gateway.isCurrent(scope);
    const started = performance.now();
    try {
      // This RPC reads in-memory state; discard its payload and measure only the round trip.
      await scope.client.request(
        "last-heartbeat",
        {},
        {
          timeoutMs: DIAGNOSTICS_POLL_INTERVAL_MS,
          signal: request.signal,
        },
      );
      if (!isCurrent()) {
        return;
      }
      this.pingSamples = [
        ...this.pingSamples.slice(-(CONNECTION_PING_SAMPLE_LIMIT - 1)),
        { at: Date.now(), value: performance.now() - started },
      ];
      this.ping = summarizeConnectionPing(this.pingSamples.map((sample) => sample.value));
      this.pingFailed = false;
    } catch {
      if (isCurrent()) {
        this.pingFailed = true;
      }
    } finally {
      if (this.pingRequest === request) {
        this.pingRequest = null;
      }
    }
  }

  private async loadSystemInfo() {
    const gatewaySource = this.gateway.gateway;
    const scope = this.gateway.capture();
    if (
      !gatewaySource ||
      gatewaySource !== this.context.gateway ||
      !scope ||
      this.systemInfoUnavailable ||
      this.systemInfoRequest ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const request = new AbortController();
    this.systemInfoRequest = request;
    this.systemInfoLoading = true;
    const isCurrent = () =>
      this.systemInfoRequest === request &&
      this.isConnected &&
      document.visibilityState !== "hidden" &&
      this.context.gateway === gatewaySource &&
      this.gateway.isCurrent(scope);
    try {
      const response = await scope.client.request<SystemInfoResult>(
        "system.info",
        {},
        {
          timeoutMs: DIAGNOSTICS_POLL_INTERVAL_MS,
          signal: request.signal,
        },
      );
      if (!isCurrent()) {
        return;
      }
      this.systemInfo = response;
      this.statusHistory = [
        ...this.statusHistory.slice(-(CONNECTION_PING_SAMPLE_LIMIT - 1)),
        {
          at: Date.now(),
          status: { eventLoop: response.eventLoop, processMemory: response.processMemory },
        },
      ];
      this.statusFailed = false;
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      this.statusFailed = true;
      if (isMissingOperatorReadScopeError(error) || isUnknownSystemInfoMethodError(error)) {
        this.systemInfo = null;
        this.systemInfoUnavailable = true;
      }
    } finally {
      if (this.systemInfoRequest === request) {
        this.systemInfoRequest = null;
        this.systemInfoLoading = false;
      }
    }
  }

  private resetConnectionDraft() {
    const { gatewayUrl, token, password } = this.context.gateway.connection;
    this.settings = { ...this.settings, gatewayUrl, token };
    this.password = password;
    this.resetSensitiveUi();
  }

  private resetSessionDraft() {
    this.sessionGatewayUrl = this.context.gateway.connection.gatewayUrl;
    this.sessionKeyBaseline = this.context.gateway.snapshot.sessionKey;
    this.settings = { ...this.settings, sessionKey: this.sessionKeyBaseline };
    this.sessionSaved = false;
  }

  private saveSession() {
    this.context.gateway.setSessionKey(this.settings.sessionKey);
    this.resetSessionDraft();
    this.sessionSaved = true;
  }

  private async forgetDevice() {
    const gateway = this.context.gateway;
    const gatewayUrl = gateway.connection.gatewayUrl;
    const confirmed = await showConfirmDialog({
      title: t("connection.browser.confirmTitle"),
      message: t("connection.browser.confirmMessage", {
        gateway: formatGatewayHost(gatewayUrl),
      }),
      confirmLabel: t("connection.browser.confirmLabel"),
      danger: true,
    });
    // A confirmation for one Gateway must never reset a newly selected Gateway.
    if (
      confirmed &&
      this.isConnected &&
      this.context.gateway === gateway &&
      gateway.connection.gatewayUrl === gatewayUrl
    ) {
      gateway.forgetDeviceToken?.();
      this.requestUpdate();
    }
  }

  private connect() {
    this.context.gateway.connect({
      gatewayUrl: this.settings.gatewayUrl,
      token: this.settings.token,
      password: this.password,
    });
  }

  private updateConnection(patch: Partial<Pick<UiSettings, "gatewayUrl" | "token">>) {
    if (patch.gatewayUrl !== undefined) {
      const credentials = resolveGatewayCredentialsForUrlEdit(
        this.settings.gatewayUrl,
        patch.gatewayUrl,
        { token: this.settings.token, password: this.password },
      );
      this.password = credentials.password;
      this.settings = { ...this.settings, ...patch, token: credentials.token };
      return;
    }
    this.settings = { ...this.settings, ...patch };
  }

  override render() {
    const gateway = this.context.gateway.snapshot;
    const live = this.context.gateway.connection;
    const dirty =
      this.settings.gatewayUrl !== live.gatewayUrl ||
      this.settings.token !== live.token ||
      this.password !== live.password;
    const body = renderConnection({
      phase: gateway.phase,
      hello: gateway.hello,
      settings: this.settings,
      liveGatewayUrl: live.gatewayUrl,
      secret: this.settings.token || this.password,
      lastError: gateway.lastError,
      systemInfo: this.systemInfo,
      systemInfoLoading: this.systemInfoLoading,
      systemInfoUnavailable: this.systemInfoUnavailable,
      ping: this.ping,
      pingFailed: this.pingFailed,
      pingSamples: this.pingSamples,
      statusHistory: this.statusHistory,
      statusFailed: this.statusFailed,
      dirty,
      sessionDirty: this.settings.sessionKey.trim() !== gateway.sessionKey,
      sessionSaved: this.sessionSaved,
      showGatewaySecret: this.gatewaySecretVisible,
      canForgetDevice: this.context.gateway.hasStoredDeviceToken?.() ?? false,
      onForgetDevice: () => void this.forgetDevice(),
      onConnectionChange: (patch) => this.updateConnection(patch),
      onSecretChange: (token) => {
        this.password = "";
        this.updateConnection({ token });
      },
      onSessionKeyChange: (sessionKey) => {
        this.sessionSaved = false;
        this.settings = {
          ...this.settings,
          sessionKey,
        };
      },
      onToggleGatewaySecretVisibility: () => {
        this.gatewaySecretVisible = !this.gatewaySecretVisible;
      },
      onConnect: () => this.connect(),
      onDiscardConnection: () => this.resetConnectionDraft(),
      onReconnect: () => this.context.gateway.connect(),
      onSaveSession: () => this.saveSession(),
      onDiscardSession: () => this.resetSessionDraft(),
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("connection")}</div>
          <div class="page-subtitle">
            ${subtitleForRoute("connection")} ${renderLearnMoreLink(CONNECTION_DOCS_URL)}
          </div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-connection-page")) {
  customElements.define("openclaw-connection-page", ConnectionPage);
}
