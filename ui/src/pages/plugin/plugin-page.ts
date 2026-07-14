import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { PluginsUiEntryPointLaunchResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { resolveEmbedSandbox } from "../../lib/chat/tool-display.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { pluginEntryPointKey, pluginTabKey } from "./route.ts";

/**
 * Bundled plugin tab views ship with the Control UI and render natively; every
 * other tab either embeds the plugin-served panel (descriptor path) in a
 * sandboxed frame or shows the unavailable card.
 */
type BundledPluginTabView = {
  render: (props: {
    host: object;
    client: GatewayBrowserClient | null;
    connected: boolean;
    embed?: {
      embedSandboxMode: ApplicationContext<RouteId>["config"]["current"]["embedSandboxMode"];
      allowExternalEmbedUrls: boolean;
    };
    onRequestUpdate?: () => void;
    // L5: custom widgets need the gateway HTTP base (iframe src) and the session
    // key (prompt dispatch). Bundled views that don't use them ignore these.
    basePath?: string;
    sessionKey?: string;
  }) => unknown;
  stop: (host: object) => void;
};

// Keyed by pluginId/tabId: tab ids are only unique within their plugin.
const BUNDLED_TAB_VIEWS: Record<string, () => Promise<BundledPluginTabView>> = {
  "workspaces/workspaces": async () => {
    const [{ renderWorkspace }, { stopWorkspace }] = await Promise.all([
      import("./workspace-view.ts"),
      import("./workspace-controller.ts"),
    ]);
    return { render: renderWorkspace, stop: stopWorkspace };
  },
  "logbook/logbook": async () => {
    const [{ renderLogbook }, { stopLogbookPolling }] = await Promise.all([
      import("./logbook-view.ts"),
      import("./logbook-controller.ts"),
    ]);
    return { render: renderLogbook, stop: stopLogbookPolling };
  },
};

export class PluginPage extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) pluginId = "";
  @property({ attribute: false }) tabId = "";
  @property({ attribute: false }) entryPointPath = "";
  @property({ attribute: false }) entryPointLabel = "";

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext<RouteId>;

  @state() private bundledView: BundledPluginTabView | null = null;
  @state() private entryPointFrameSrc = "";
  @state() private entryPointLaunchFailed = false;

  private bundledViewId: string | null = null;
  private entryPointLaunchKey: string | null = null;
  private entryPointLaunchToken: object | null = null;
  private bundledViewLoadToken: object | null = null;
  private bundledViewHost: object = {};
  private gatewaySource?: ApplicationContext<RouteId>["gateway"];
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
    (gateway) => this.updateGatewaySource(gateway),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.stopBundledView();
    super.disconnectedCallback();
  }

  private tabKey(): string {
    return pluginTabKey({ pluginId: this.pluginId, id: this.tabId });
  }

  private currentEntryPointKey(): string | null {
    const path = this.entryPointPath.trim();
    if (!path) {
      return null;
    }
    return pluginEntryPointKey({ pluginId: this.pluginId, id: this.tabId, path });
  }

  protected loadBundledView(key: string): Promise<BundledPluginTabView> {
    const load = BUNDLED_TAB_VIEWS[key];
    return load ? load() : Promise.reject(new Error(`Unknown bundled plugin tab: ${key}`));
  }

  override willUpdate() {
    if (!this.isConnected) {
      return;
    }
    const entryPointKey = this.currentEntryPointKey();
    if (entryPointKey) {
      this.stopBundledView();
      if (this.entryPointLaunchKey !== entryPointKey) {
        this.entryPointLaunchKey = entryPointKey;
        this.entryPointLaunchToken = null;
        this.entryPointFrameSrc = "";
        this.entryPointLaunchFailed = false;
      }
      if (
        !this.entryPointFrameSrc &&
        !this.entryPointLaunchFailed &&
        !this.entryPointLaunchToken &&
        this.gatewayConnected &&
        this.gatewayClient
      ) {
        void this.launchEntryPoint(entryPointKey, this.gatewayClient);
      }
      return;
    }
    if (this.entryPointLaunchKey !== null) {
      this.entryPointLaunchKey = null;
      this.entryPointLaunchToken = null;
      this.entryPointFrameSrc = "";
      this.entryPointLaunchFailed = false;
    }
    const key = this.tabKey();
    const hasBundledDescriptor = this.tabInfo() !== undefined && key in BUNDLED_TAB_VIEWS;
    // Switching between plugin tabs reuses this element; the previous bundled
    // view must stop its background polling before the next one renders. A
    // descriptor can also disappear in place after disablement or scope loss.
    if (this.bundledViewId !== null && (this.bundledViewId !== key || !hasBundledDescriptor)) {
      this.stopBundledView();
    }
    if (this.bundledViewId === null && hasBundledDescriptor) {
      const loadToken = {};
      this.bundledViewId = key;
      this.bundledViewLoadToken = loadToken;
      void this.loadBundledView(key).then((view) => {
        if (
          this.bundledViewLoadToken === loadToken &&
          this.bundledViewId === key &&
          this.tabKey() === key
        ) {
          this.bundledView = view;
        }
      });
    }
  }

  private stopBundledView() {
    this.replaceBundledViewHost();
    this.bundledView = null;
    this.bundledViewId = null;
    this.bundledViewLoadToken = null;
  }

  private replaceBundledViewHost() {
    this.bundledView?.stop(this.bundledViewHost);
    // Async controller work is keyed by host. A new host makes every completion
    // from the retired connection epoch unreachable without coupling plugins to Lit.
    this.bundledViewHost = {};
  }

  private updateGatewaySource(gateway: ApplicationContext<RouteId>["gateway"]) {
    const { client, connected } = gateway.snapshot;
    if (
      this.gatewaySource === gateway &&
      this.gatewayClient === client &&
      this.gatewayConnected === connected
    ) {
      return;
    }
    this.replaceBundledViewHost();
    this.gatewaySource = gateway;
    this.gatewayClient = client;
    this.gatewayConnected = connected;
    if (this.currentEntryPointKey()) {
      this.entryPointLaunchToken = null;
      this.entryPointFrameSrc = "";
      this.entryPointLaunchFailed = false;
    }
  }

  private tabInfo(): GatewayControlUiPluginTab | undefined {
    const tabs = this.context?.gateway.snapshot.hello?.controlUiTabs ?? [];
    return tabs.find((tab) => tab.pluginId === this.pluginId && tab.id === this.tabId);
  }

  private async launchEntryPoint(expectedKey: string, client: GatewayBrowserClient): Promise<void> {
    const context = this.context;
    const path = this.entryPointPath.trim();
    if (!context || !path) {
      return;
    }
    const launchToken = {};
    this.entryPointLaunchToken = launchToken;
    const activeSession = context.sessions.state.result?.sessions.find(
      (row) => row.key === context.gateway.snapshot.sessionKey,
    );
    const contextTokens =
      activeSession?.contextTokens ?? context.sessions.state.result?.defaults?.contextTokens;
    try {
      const result = (await client.request("plugins.uiEntryPointLaunch", {
        id: this.tabId,
        pluginId: this.pluginId,
        path,
        ...(context.gateway.snapshot.sessionKey
          ? { sessionKey: context.gateway.snapshot.sessionKey }
          : {}),
        ...(typeof contextTokens === "number" && contextTokens > 0 ? { contextTokens } : {}),
      })) as PluginsUiEntryPointLaunchResult;
      if (
        this.entryPointLaunchToken === launchToken &&
        this.currentEntryPointKey() === expectedKey
      ) {
        this.entryPointFrameSrc = result.path;
      }
    } catch {
      if (
        this.entryPointLaunchToken === launchToken &&
        this.currentEntryPointKey() === expectedKey
      ) {
        this.entryPointLaunchFailed = true;
      }
    } finally {
      if (this.entryPointLaunchToken === launchToken) {
        this.entryPointLaunchToken = null;
      }
    }
  }

  override render() {
    const context = this.context;
    if (!context) {
      return nothing;
    }
    const entryPointKey = this.currentEntryPointKey();
    if (entryPointKey) {
      if (this.entryPointLaunchFailed) {
        return html`
          <section class="card lazy-view-state" role="status">
            <div class="card-title">${t("pluginTabs.unavailableTitle")}</div>
            <div class="card-sub">${t("pluginTabs.unavailableSubtitle")}</div>
          </section>
        `;
      }
      if (!this.entryPointFrameSrc) {
        return nothing;
      }
      return html`
        <section class="plugin-ui-entry-frame-shell">
          <iframe
            class="plugin-ui-entry-frame"
            src=${this.entryPointFrameSrc}
            title=${this.entryPointLabel || this.tabId}
            sandbox=${resolveEmbedSandbox(context.config.current.embedSandboxMode)}
            referrerpolicy="no-referrer"
          ></iframe>
        </section>
      `;
    }
    // Only advertised tabs render: hello omits descriptors whose plugin is
    // inactive or whose required scopes the connection lacks.
    const info = this.tabInfo();
    if (info && this.tabKey() in BUNDLED_TAB_VIEWS) {
      if (!this.bundledView) {
        return nothing;
      }
      const snapshot = context.gateway.snapshot;
      // Config may be absent in unit harnesses; the Workspaces view defaults the
      // embed policy to strict when `embed` is omitted.
      const config = context.config?.current;
      return this.bundledView.render({
        host: this.bundledViewHost,
        client: snapshot.client,
        connected: snapshot.connected,
        embed: config
          ? {
              embedSandboxMode: config.embedSandboxMode,
              allowExternalEmbedUrls: config.allowExternalEmbedUrls,
            }
          : undefined,
        onRequestUpdate: () => this.requestUpdate(),
        basePath: context.basePath,
        sessionKey: snapshot.sessionKey,
      });
    }
    if (info?.path) {
      return html`
        <section class="plugin-tab-embed">
          <iframe
            class="plugin-tab-embed__frame"
            src=${info.path}
            title=${info.label}
            sandbox=${resolveEmbedSandbox(context.config.current.embedSandboxMode)}
          ></iframe>
        </section>
      `;
    }
    return html`
      <section class="card lazy-view-state" role="status">
        <div class="card-title">${t("pluginTabs.unavailableTitle")}</div>
        <div class="card-sub">${t("pluginTabs.unavailableSubtitle")}</div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-plugin-page")) {
  customElements.define("openclaw-plugin-page", PluginPage);
}
