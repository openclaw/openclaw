import { consume } from "@lit/context";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { titleForRoute } from "../../app-navigation.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { isNativeWebChromeHost } from "../../app/native-web-chrome.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import type { McpAppOpenDetail } from "../../components/mcp-app-launch.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerMcpAppEnglish } from "../../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { McpAppCatalogController } from "../../lib/mcp-app-catalog.ts";
import { mcpAppRouteFromSearch, resolveMcpAppRouteServer } from "../../lib/mcp-app-route.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../components/mcp-app-catalog.ts";
import { buildMacGatewayLaunchUrl } from "./gateway-launch.ts";
import { renderApps } from "./view.ts";

registerMcpAppEnglish();

class AppsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @property({ attribute: false }) appSearch = "";
  private appLaunch: McpAppOpenDetail | undefined;
  private appLaunchKey = "";
  private conversationError: string | null = null;
  private readonly appCatalog = new McpAppCatalogController(
    this,
    () => this.context,
    () => ({
      sessionKey: mcpAppRouteFromSearch(this.appSearch)
        ? (this.context?.gateway.snapshot.sessionKey ?? "")
        : "",
      agentId: this.context?.agentSelection.state.selectedId ?? undefined,
    }),
    () => true,
  );

  constructor() {
    super();
    void new SubscriptionsController(this).watchStore(() => this.context?.gateway);
  }

  private renderAppConversation(route: NonNullable<ReturnType<typeof mcpAppRouteFromSearch>>) {
    const gateway = this.context.gateway;
    if (!this.conversationError) {
      void ensureCustomElementDefined(
        "openclaw-chat-pane",
        () => import("../chat/route-entry.ts"),
      ).catch((error: unknown) => {
        this.conversationError = formatUiError(error);
        this.requestUpdate();
      });
    }
    const search = new URLSearchParams(this.appSearch);
    const settings = search.get("settings") === "1";
    const server = resolveMcpAppRouteServer(this.appCatalog.servers, route, settings);
    const entrypoint =
      server?.entrypoints.find(
        (entry) =>
          entry.toolName === route.toolName &&
          (entry.entrypoint.type === "global" ||
            (settings && entry.entrypoint.type === "settings")),
      ) ??
      (settings && server && server.settings && server.settings.readTool === route.toolName
        ? {
            toolName: server.settings.readTool,
            title: server.label,
            resourceUri: "",
            entrypoint: { type: "settings" as const },
          }
        : undefined);
    const key = JSON.stringify([
      this.appSearch,
      gateway.snapshot.sessionKey,
      this.context.agentSelection.state.selectedId,
      gateway.connectionRevision,
    ]);
    if (key !== this.appLaunchKey || this.appLaunch?.owner !== gateway.snapshot.client) {
      this.appLaunch = undefined;
      this.appLaunchKey = key;
    }
    if (!this.appLaunch && server && entrypoint) {
      this.appLaunch = {
        sessionKey: gateway.snapshot.sessionKey,
        agentId: this.context.agentSelection.state.selectedId ?? undefined,
        owner: gateway.snapshot.client,
        serverName: server.serverName,
        entrypoint,
        deepLink: route.deepLink,
        settings,
        quickAction: search.get("quickAction") === "1",
      };
    }
    const launch = this.appLaunch;
    return html`<button class="btn" @click=${() => this.context.navigate("apps")}>
        ${t("mcpApp.close")}
      </button>
      ${
        this.conversationError
          ? html`<p role="alert">${this.conversationError}</p>
              <button
                class="btn"
                @click=${() => {
                  this.conversationError = null;
                  this.requestUpdate();
                }}
              >
                ${t("mcpApp.retry")}
              </button>`
          : launch
            ? keyed(
                JSON.stringify([launch.sessionKey, gateway.connectionRevision]),
                html`<openclaw-chat-pane
                  class="mcp-app-conversation"
                  .sessionKey=${launch.sessionKey}
                  .agentId=${launch.agentId}
                  .paneId=${"plugin-app"}
                  .presentationId=${`plugin-app:${launch.sessionKey}`}
                  .mcpAppLaunch=${launch}
                ></openclaw-chat-pane>`,
              )
            : this.appCatalog.loading
              ? html`<p role="status">${t("mcpApp.loading")}</p>`
              : html`<p role="alert">${this.appCatalog.error ?? t("mcpApp.invalidLink")}</p>`
      }`;
  }

  override render() {
    const gatewaySnapshot = this.context.gateway.snapshot;
    const canPairDevice =
      gatewaySnapshot.phase === "connected" &&
      hasOperatorAdminAccess(gatewaySnapshot.hello?.auth ?? null);
    const appRoute = mcpAppRouteFromSearch(this.appSearch);
    const body = appRoute
      ? nothing
      : renderApps({
          onNavigate: (routeId: RouteId) => this.context.navigate(routeId),
          macGatewayLaunchUrl:
            gatewaySnapshot.phase === "connected" && !isNativeWebChromeHost()
              ? buildMacGatewayLaunchUrl(
                  this.context.gateway.connection.gatewayUrl,
                  asOptionalRecord(gatewaySnapshot.hello?.snapshot)?.controlUiIdentityUrl,
                )
              : null,
          onPairDevice: canPairDevice
            ? () => void this.context.overlays.openDevicePairSetup()
            : undefined,
        });
    return html`<section class="content-header" ${shellLayoutTraits({ toolbarHeader: true })}>
        <div><div class="page-title">${titleForRoute("apps")}</div></div>
      </section>
      ${
        appRoute
          ? this.renderAppConversation(appRoute)
          : renderSettingsWorkspace(
              html`<openclaw-mcp-app-catalog surface="global"></openclaw-mcp-app-catalog>${body}`,
            )
      }`;
  }
}
if (!customElements.get("openclaw-apps-page")) {
  customElements.define("openclaw-apps-page", AppsPage);
}
