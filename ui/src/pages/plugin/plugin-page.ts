import { consume } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../../api/gateway.ts";
import type { PluginsUiEntryPointLaunchResult } from "../../api/types.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { resolveEmbedSandbox } from "../../lib/chat/tool-display.ts";
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
    onRequestUpdate?: () => void;
  }) => unknown;
  stop: (host: object) => void;
};

// Keyed by pluginId/tabId: tab ids are only unique within their plugin.
const BUNDLED_TAB_VIEWS: Record<string, () => Promise<BundledPluginTabView>> = {
  "logbook/logbook": async () => {
    const [view, controller] = await Promise.all([
      import("./logbook-view.ts"),
      import("./logbook-controller.ts"),
    ]);
    return { render: view.renderLogbook, stop: controller.stopLogbookPolling };
  },
};

export class PluginPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) pluginId = "";
  @property({ attribute: false }) tabId = "";
  @property({ attribute: false }) entryPointPath = "";
  @property({ attribute: false }) entryPointLabel = "";

  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext<RouteId>;

  @state() private bundledView: BundledPluginTabView | null = null;
  @state() private entryPointFrameSrc = "";

  private bundledViewId: string | null = null;
  private entryPointLaunchKey: string | null = null;
  private stopGatewaySubscription: (() => void) | undefined;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
    this.stopGatewaySubscription ??= this.context?.gateway.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback() {
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
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

  override willUpdate() {
    const entryPointKey = this.currentEntryPointKey();
    if (entryPointKey) {
      this.stopBundledView();
      if (this.entryPointLaunchKey !== entryPointKey) {
        this.entryPointLaunchKey = entryPointKey;
        this.entryPointFrameSrc = "";
        void this.launchEntryPoint(entryPointKey);
      }
      return;
    }
    if (this.entryPointLaunchKey !== null) {
      this.entryPointLaunchKey = null;
      this.entryPointFrameSrc = "";
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
      this.bundledViewId = key;
      void BUNDLED_TAB_VIEWS[key]().then((view) => {
        if (this.bundledViewId === this.tabKey()) {
          this.bundledView = view;
        }
      });
    }
  }

  private stopBundledView() {
    this.bundledView?.stop(this);
    this.bundledView = null;
    this.bundledViewId = null;
  }

  private tabInfo(): GatewayControlUiPluginTab | undefined {
    const tabs = this.context?.gateway.snapshot.hello?.controlUiTabs ?? [];
    return tabs.find((tab) => tab.pluginId === this.pluginId && tab.id === this.tabId);
  }

  private async launchEntryPoint(expectedKey: string): Promise<void> {
    const context = this.context;
    const path = this.entryPointPath.trim();
    if (
      !context ||
      !context.gateway.snapshot.connected ||
      !context.gateway.snapshot.client ||
      !path
    ) {
      return;
    }
    const client = context.gateway.snapshot.client;
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
      if (this.currentEntryPointKey() === expectedKey) {
        this.entryPointFrameSrc = result.path;
      }
    } catch {
      if (this.currentEntryPointKey() === expectedKey) {
        this.entryPointFrameSrc = path;
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
      return this.bundledView.render({
        host: this,
        client: snapshot.client,
        connected: snapshot.connected,
        onRequestUpdate: () => this.requestUpdate(),
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
