import { consume } from "@lit/context";
import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { resolveControlUiAuthToken } from "../../../app/control-ui-auth.ts";
import { isBrowserPanelAvailable } from "../../../app/panel-availability.ts";
import { renderBoardWidgetError } from "../../../components/board/board-widget-cell-render.ts";
import {
  requestBrowserDashboard,
  type BrowserDashboard,
} from "../../../components/browser/browser-client.ts";
import "../../../components/browser/browser-panel.ts";
import { t } from "../../../i18n/index.ts";
import { registerBrowserEnglish } from "../../../i18n/locales/en-browser.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import { formatUiError } from "../../format-error.ts";
import type { BoardWidget } from "../types.ts";
import "./browser.css";

registerBrowserEnglish();

class OpenClawBrowserDashboardWidget extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardWidget;
  @property({ attribute: false }) session: BoardGetParams = { sessionKey: "" };
  @property({ type: Boolean }) active = true;

  @state() private dashboard?: BrowserDashboard;
  @state() private error: unknown;
  @state() private pending = false;

  private scope?: { key: string; client: ApplicationContext["gateway"]["snapshot"]["client"] };
  private generation = 0;
  private refreshNeeded = false;
  constructor() {
    super();
    void new SubscriptionsController(this).watch(
      () => this.context?.gateway,
      (gateway, notify) => {
        const snapshot = gateway.subscribe(notify);
        const events = gateway.subscribeEvents((event) => {
          const payload = asNullableRecord(event.payload);
          if (
            event.event !== "plugin.browser.dashboard_changed" ||
            payload?.instanceId !== this.widget?.instanceId ||
            payload?.name !== this.widget?.name
          ) {
            return;
          }
          this.refreshNeeded = true;
          if (this.active) {
            void this.request("inspect");
          }
        });
        return () => {
          snapshot();
          events();
        };
      },
    );
  }

  override willUpdate(): void {
    const client = this.context?.gateway.snapshot.client ?? null;
    const key = JSON.stringify([
      this.session,
      this.widget?.instanceId,
      this.widget?.name,
      this.widget?.props,
    ]);
    if (this.scope?.key !== key || this.scope.client !== client) {
      this.scope = { key, client };
      this.generation += 1;
      this.dashboard = undefined;
      this.error = undefined;
      this.pending = false;
      this.refreshNeeded = false;
    }
    if (this.active && this.available && !this.pending && !this.error) {
      if (this.refreshNeeded) {
        void this.request("inspect");
      } else if (!this.dashboard || (!this.dashboard.paused && !this.dashboard.browserTab)) {
        void this.request("open");
      }
    }
  }

  override disconnectedCallback(): void {
    this.generation += 1;
    this.scope = undefined;
    super.disconnectedCallback();
  }

  private get available(): boolean {
    return Boolean(this.context && isBrowserPanelAvailable(this.context.gateway.snapshot));
  }

  private async request(action: "open" | "resume" | "stop" | "inspect"): Promise<void> {
    const client = this.context?.gateway.snapshot.client;
    const instanceId = this.widget?.instanceId;
    if (!client || !this.available || !this.widget || this.pending) {
      return;
    }
    if (!instanceId) {
      this.error = new Error(t("browser.dashboardMissingIdentity"));
      return;
    }
    const generation = ++this.generation;
    if (action === "inspect") {
      this.refreshNeeded = false;
    }
    this.pending = true;
    this.error = undefined;
    try {
      const dashboard = await requestBrowserDashboard(
        client,
        {
          ...this.session,
          name: this.widget.name,
          instanceId,
        },
        action,
      );
      if (this.isConnected && generation === this.generation && client === this.scope?.client) {
        this.dashboard = dashboard;
      }
    } catch (error) {
      if (this.isConnected && generation === this.generation) {
        this.error = error;
      }
    } finally {
      if (this.isConnected && generation === this.generation) {
        this.pending = false;
        if (this.refreshNeeded && this.active) {
          void this.request("inspect");
        }
      }
    }
  }

  override render() {
    const gateway = this.context?.gateway;
    const dashboard = this.dashboard;
    if (!this.active && !dashboard) {
      return nothing;
    }
    if (!gateway || !this.available) {
      return html`<p class="board-browser__notice">${t("browser.dashboardUnavailable")}</p>`;
    }
    return html`<div class="board-browser" data-chat-autotype-exempt>
      <div class="board-browser__content">
        ${
          dashboard?.browserTab && !dashboard.paused
            ? html`<openclaw-browser-panel
                embedded
                .client=${gateway.snapshot.client}
                .available=${this.available}
                .remoteAvailable=${this.available}
                .presented=${this.active}
                .sessionKey=${dashboard.sessionKey}
                .fixedTab=${dashboard.browserTab}
                .dashboardTarget=${{ ...this.session, name: dashboard.name, instanceId: dashboard.instanceId }}
                .resourceBasePath=${this.context?.resourceBasePath ?? ""}
                .authToken=${resolveControlUiAuthToken({
                  hello: gateway.snapshot.hello,
                  password: gateway.connection.password,
                  settings: { token: gateway.connection.token },
                })}
              ></openclaw-browser-panel>`
            : this.error
              ? renderBoardWidgetError(this.error, () => void this.request("open"))
              : html` <p class="board-browser__notice" role="status">
                  ${t(dashboard?.stopping ? "browser.dashboardStopping" : dashboard?.paused ? "browser.dashboardStopped" : "browser.loading")}
                </p>`
        }
      </div>
      <div class="board-browser__footer">
        <span>${t("browser.dashboardShared")}</span>
        <div>
          <button
            type="button"
            class="btn btn--small"
            ?disabled=${this.pending}
            @click=${() => void this.request(dashboard?.stopping ? "stop" : dashboard?.paused ? "resume" : "open")}
          >
            ${t(dashboard?.stopping ? "browser.dashboardRetryStop" : dashboard?.paused ? "browser.dashboardResume" : "browser.dashboardReconnect")}
          </button>
          ${
            dashboard?.browserTab && !dashboard.paused
              ? html`<button
                  type="button"
                  class="btn btn--small"
                  ?disabled=${this.pending}
                  @click=${() => void this.request("stop")}
                >
                  ${t("browser.dashboardStop")}
                </button>`
              : nothing
          }
        </div>
      </div>
      ${this.error && dashboard?.browserTab ? html`<p role="alert" class="board-browser__error">${formatUiError(this.error)}</p>` : nothing}
    </div>`;
  }
}

if (!customElements.get("openclaw-browser-dashboard-widget")) {
  customElements.define("openclaw-browser-dashboard-widget", OpenClawBrowserDashboardWidget);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-browser-dashboard-widget": OpenClawBrowserDashboardWidget;
  }
}
