import "../../styles/connection.css";
import { createSignal, onCleanup } from "solid-js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  loadSettings,
  resolveGatewayCredentialsForUrlEdit,
  type UiSettings,
} from "../../app/settings.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { GatewayStatusSample } from "../../components/gateway-vitals.ts";
import { LearnMoreLink, SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import type { SparklineSample } from "../../components/sparkline-tile.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { formatGatewayHost } from "../../lib/gateway-host.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import type { GatewayPageChange } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import {
  canReadSystemInfo,
  readSystemInfo,
  SYSTEM_INFO_POLL_INTERVAL_MS,
} from "../../lib/system-info.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import {
  CONNECTION_PING_SAMPLE_LIMIT,
  summarizeConnectionPing,
  type ConnectionPingSummary,
} from "./latency.ts";
import { isUnknownSystemInfoMethodError } from "./system-info.ts";
import { ConnectionView } from "./view.tsx";

const CONNECTION_DOCS_URL = "https://docs.openclaw.ai/gateway/remote";

class ConnectionDraft {
  settings: UiSettings = loadSettings();
  password = "";
  gatewaySecretVisible = false;
  systemInfo: SystemInfoResult | null = null;
  systemInfoUnavailable = false;
  ping: ConnectionPingSummary | null = null;
  pingFailed = false;
  pingSamples: SparklineSample[] = [];
  pingRequest: AbortController | null = null;
  statusHistory: GatewayStatusSample[] = [];
  statusFailed = false;
  systemInfoRequest: AbortController | null = null;
  private sessionKeyBaseline = "";
  private sessionGatewayUrl = "";
  sessionSaved = false;
  polling!: ReturnType<typeof useVisiblePoll>;
  gateway!: ReturnType<typeof useGatewayPage>;

  constructor(
    readonly context: ApplicationContext,
    readonly host: HTMLElement,
    readonly changed: () => void,
  ) {}

  private get isConnected() {
    return this.host.isConnected;
  }

  dispose() {
    this.resetDiagnostics();
    this.gatewaySecretVisible = false;
  }

  handleGatewaySnapshot({ snapshot, initial, sourceChanged, clientChanged }: GatewayPageChange) {
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
      this.gatewaySecretVisible = false;
      this.systemInfo = null;
    }
    if (snapshot.phase === "connected" && snapshot.hello) {
      this.systemInfoUnavailable = !canReadSystemInfo(snapshot);
      if (this.systemInfoUnavailable) {
        this.gateway.invalidate();
        this.systemInfoRequest?.abort();
        this.systemInfoRequest = null;
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
      void this.loadDiagnostic("system-info");
    }
  }

  private stopDiagnosticsPolling() {
    this.polling.stop();
    this.pingRequest?.abort();
    this.pingRequest = null;
    this.systemInfoRequest?.abort();
    this.systemInfoRequest = null;
  }

  private resetDiagnostics() {
    this.stopDiagnosticsPolling();
    this.pingSamples = [];
    this.ping = null;
    this.pingFailed = false;
    this.statusHistory = [];
    this.statusFailed = false;
  }

  syncDiagnosticsPolling() {
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
    if (this.polling.start()) {
      this.refreshDiagnostics();
    }
  }

  refreshDiagnostics() {
    void this.loadDiagnostic("ping");
    void this.loadDiagnostic("system-info");
  }

  private async loadDiagnostic(kind: "ping" | "system-info") {
    const gatewaySource = this.gateway.gateway;
    const scope = this.gateway.capture();
    const isPing = kind === "ping";
    const requestKey = isPing ? "pingRequest" : "systemInfoRequest";
    if (
      !gatewaySource ||
      gatewaySource !== this.context.gateway ||
      !scope ||
      (!isPing && this.systemInfoUnavailable) ||
      this[requestKey] ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const request = new AbortController();
    this[requestKey] = request;
    this.changed();
    const isCurrent = () =>
      this[requestKey] === request &&
      this.isConnected &&
      document.visibilityState !== "hidden" &&
      this.context.gateway === gatewaySource &&
      this.gateway.isCurrent(scope);
    const started = isPing ? performance.now() : 0;
    try {
      if (isPing) {
        // This RPC reads in-memory state; discard its payload and measure only the round trip.
        await scope.client.request(
          "last-heartbeat",
          {},
          {
            timeoutMs: SYSTEM_INFO_POLL_INTERVAL_MS,
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
      } else {
        const sample = await readSystemInfo(gatewaySource, request.signal);
        if (!isCurrent()) {
          return;
        }
        this.systemInfo = sample.value;
        this.polling.stop();
        this.polling.start();
        if (this.statusHistory.at(-1)?.at !== sample.at) {
          this.statusHistory = [
            ...this.statusHistory.slice(-(CONNECTION_PING_SAMPLE_LIMIT - 1)),
            {
              at: sample.at,
              status: {
                eventLoop: sample.value.eventLoop,
                processMemory: sample.value.processMemory,
              },
            },
          ];
        }
        this.statusFailed = false;
      }
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      if (isPing) {
        this.pingFailed = true;
      } else {
        this.statusFailed = true;
        if (isMissingOperatorReadScopeError(error) || isUnknownSystemInfoMethodError(error)) {
          this.systemInfo = null;
          this.systemInfoUnavailable = true;
        }
      }
    } finally {
      if (this[requestKey] === request) {
        this[requestKey] = null;
        this.changed();
      }
    }
  }

  private resetConnectionDraft() {
    const { gatewayUrl, token, password } = this.context.gateway.connection;
    this.settings = { ...this.settings, gatewayUrl, token };
    this.password = password;
    this.gatewaySecretVisible = false;
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
      this.changed();
    }
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

  viewProps() {
    const gateway = this.context.gateway.snapshot;
    const live = this.context.gateway.connection;
    const dirty =
      this.settings.gatewayUrl !== live.gatewayUrl ||
      this.settings.token !== live.token ||
      this.password !== live.password;
    return {
      phase: gateway.phase,
      hello: gateway.hello,
      settings: this.settings,
      liveGatewayUrl: live.gatewayUrl,
      secret: this.settings.token || this.password,
      lastError: gateway.lastError,
      systemInfo: this.systemInfo,
      systemInfoLoading: this.systemInfoRequest !== null,
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
      onConnectionChange: (patch: Partial<Pick<UiSettings, "gatewayUrl" | "token">>) => {
        this.updateConnection(patch);
        this.changed();
      },
      onSecretChange: (token: string) => {
        this.password = "";
        this.updateConnection({ token });
        this.changed();
      },
      onSessionKeyChange: (sessionKey: string) => {
        this.sessionSaved = false;
        this.settings = {
          ...this.settings,
          sessionKey,
        };
        this.changed();
      },
      onToggleGatewaySecretVisibility: () => {
        this.gatewaySecretVisible = !this.gatewaySecretVisible;
        this.changed();
      },
      onConnect: () =>
        this.context.gateway.connect({
          gatewayUrl: this.settings.gatewayUrl,
          token: this.settings.token,
          password: this.password,
        }),
      onDiscardConnection: () => {
        this.resetConnectionDraft();
        this.changed();
      },
      onReconnect: () => this.context.gateway.connect(),
      onSaveSession: () => {
        this.saveSession();
        this.changed();
      },
      onDiscardSession: () => {
        this.resetSessionDraft();
        this.changed();
      },
    };
  }
}

function ConnectionContent(_props: object, host: HTMLElement) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const changed = () => setRevision((value) => value + 1);
  const draft = new ConnectionDraft(context, host, changed);
  draft.polling = useVisiblePoll(SYSTEM_INFO_POLL_INTERVAL_MS, () => draft.refreshDiagnostics());
  draft.gateway = useGatewayPage({
    getGateway: () => context.gateway,
    invalidateRequests: () => draft.dispose(),
    onSnapshot: (change) => {
      draft.handleGatewaySnapshot(change);
      changed();
    },
    onPageActivation: () => draft.syncDiagnosticsPolling(),
  });
  onCleanup(() => draft.dispose());
  const props = () => {
    revision();
    return draft.viewProps();
  };
  return (
    <>
      <SettingsPageHeader
        title={titleForRoute("connection", t)}
        subtitle={
          <>
            {subtitleForRoute("connection", t)} <LearnMoreLink url={CONNECTION_DOCS_URL} />
          </>
        }
      />
      <SettingsWorkspace>
        <ConnectionView {...props()} />
      </SettingsWorkspace>
    </>
  );
}

export const ConnectionPage = defineSolidBridge("openclaw-connection-page", ConnectionContent, {
  properties: {},
});
