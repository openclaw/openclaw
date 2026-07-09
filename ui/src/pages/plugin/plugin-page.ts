import { consume } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { resolveEmbedSandbox } from "../../lib/chat/tool-display.ts";
import { pluginTabKey } from "./route.ts";

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
  "codex-supervisor/sessions": async () => {
    const [view, controller] = await Promise.all([
      import("./codex-sessions-view.ts"),
      import("./codex-sessions-controller.ts"),
    ]);
    return { render: view.renderCodexSessions, stop: controller.stopCodexSessionsPolling };
  },
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

  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext<RouteId>;

  @state() private bundledView: BundledPluginTabView | null = null;

  private bundledViewId: string | null = null;
  private bundledViewLoadToken: object | null = null;
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

  protected loadBundledView(key: string): Promise<BundledPluginTabView> {
    return BUNDLED_TAB_VIEWS[key]();
  }

  override willUpdate() {
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
    this.bundledView?.stop(this);
    this.bundledView = null;
    this.bundledViewId = null;
    this.bundledViewLoadToken = null;
  }

  private tabInfo(): GatewayControlUiPluginTab | undefined {
    const tabs = this.context?.gateway.snapshot.hello?.controlUiTabs ?? [];
    return tabs.find((tab) => tab.pluginId === this.pluginId && tab.id === this.tabId);
  }

  override render() {
    const context = this.context;
    if (!context) {
      return nothing;
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
