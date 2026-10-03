import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { isQuestionThumbnail } from "../../../packages/gateway-protocol/src/question-media.js";
import type {
  McpAppDiscoveredEntrypoint,
  McpAppDiscoveredServer,
} from "../../../src/shared/mcp-app-extensions.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../lib/format-error.ts";
import { McpAppCatalogController } from "../lib/mcp-app-catalog.ts";
import { mcpAppRouteSearch } from "../lib/mcp-app-route.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { generateUUID } from "../lib/uuid.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import { requestMcpAppOpen } from "./mcp-app-launch.ts";
import "../styles/mcp-app-extensions.css";

registerMcpAppEnglish();

export class McpAppCatalog extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId = "";
  @property() surface: "global" | "thread" | "sidebar" | "file" = "global";
  @property({ attribute: false }) filePath = "";
  @state() private expanded = false;
  @state() private error: string | null = null;
  @state() private onboardingBusy = false;
  private target = () => ({
    sessionKey: this.sessionKey || this.context?.gateway.snapshot.sessionKey || "",
    agentId: this.agentId || this.context?.agentSelection.state.selectedId || undefined,
  });
  private readonly catalog = new McpAppCatalogController(this, () => this.context, this.target);
  private entries(server: McpAppDiscoveredServer) {
    return server.entrypoints.filter(({ entrypoint }) =>
      this.surface === "file"
        ? entrypoint.type === "file" &&
          entrypoint.extensions.some((extension) =>
            this.filePath.toLowerCase().endsWith(extension.toLowerCase()),
          )
        : entrypoint.type === (this.surface === "sidebar" ? "global" : this.surface),
    );
  }
  private icon(server: McpAppDiscoveredServer, entry: McpAppDiscoveredEntrypoint) {
    const mode = document.documentElement.dataset.themeMode;
    const icon = [...(entry.icons ?? []), ...(server.icons ?? [])].find(
      (candidate) =>
        (!candidate.theme || candidate.theme === mode) && isQuestionThumbnail(candidate.src),
    );
    return icon
      ? html`<img class="mcp-app-icon" src=${icon.src} alt="" referrerpolicy="no-referrer" />`
      : icons.puzzle;
  }
  private open(
    server: McpAppDiscoveredServer,
    entrypoint: McpAppDiscoveredEntrypoint,
    settings = false,
    quickAction = false,
  ) {
    if (!this.context) {
      return;
    }
    this.error = null;
    if (this.surface === "sidebar" || this.surface === "global") {
      const search = mcpAppRouteSearch({
        kind: "server",
        serverName: server.serverName,
        toolName: entrypoint.toolName,
        deepLink: "/",
      });
      this.context.navigate("apps", {
        search: `${search}${settings ? "&settings=1" : ""}${quickAction ? "&quickAction=1" : ""}`,
      });
      return;
    }
    if (
      requestMcpAppOpen(this, {
        ...this.target(),
        owner: this.context.gateway.snapshot.client,
        serverName: server.serverName,
        entrypoint,
        settings,
        quickAction,
        ...(this.surface === "file" ? { filePath: this.filePath } : {}),
      })
    ) {
      this.expanded = false;
    } else {
      this.error = t("mcpApp.errors.mountUnavailable");
    }
  }
  private async onboard(pluginId: string) {
    const context = this.context;
    const client = context?.gateway.snapshot.client;
    if (!context || !client || this.onboardingBusy) {
      return;
    }
    const target = this.target();
    this.onboardingBusy = true;
    try {
      await client.request("mcp.app.onboard", {
        ...target,
        pluginId,
        idempotencyKey: generateUUID(),
      });
      if (!this.isConnected || context.gateway.snapshot.client !== client) {
        return;
      }
      const route = sessionNavigationTarget({
        context,
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        face: "chat",
      });
      context.navigate("chat", route.options);
    } catch (error) {
      if (context.gateway.snapshot.client === client) {
        this.error = formatUiError(error);
      }
    } finally {
      this.onboardingBusy = false;
    }
  }
  override render() {
    if (!this.catalog.available) {
      return nothing;
    }
    const rows = this.catalog.servers.flatMap((server) =>
      this.entries(server).map((entry) => ({ server, entry })),
    );
    const compact = this.surface === "thread" || this.surface === "file";
    if (this.surface === "sidebar") {
      return html`${rows.map(({ server, entry }) => html`<button type="button" class="nav-item" @click=${() => this.open(server, entry)} title=${server.label}><span class="nav-item__icon">${this.icon(server, entry)}</span><span class="nav-item__text">${entry.title}</span></button>`)}`;
    }
    if (this.surface === "file" && !rows.length) {
      return nothing;
    }
    if (
      this.surface === "thread" &&
      !rows.length &&
      !this.catalog.onboarding.length &&
      !this.catalog.servers.some((server) => server.settings)
    ) {
      return nothing;
    }
    return html`<section class="mcp-app-catalog ${compact ? "mcp-app-catalog--compact" : ""}">
      ${
        compact
          ? html`<button
              class="btn btn--sm"
              type="button"
              aria-expanded=${String(this.expanded)}
              @click=${() => {
                this.expanded = !this.expanded;
              }}
            >
              ${icons.puzzle}
              ${t(this.surface === "file" ? "mcpApp.openWith" : "mcpApp.threadApps")}
            </button>`
          : html`<h2>${t("mcpApp.catalogTitle")}</h2>
              <p class="muted">${t("mcpApp.catalogDescription")}</p>`
      }
      ${
        !compact || this.expanded
          ? html`<div class="mcp-app-catalog__entries">
              ${this.catalog.loading ? html`<p role="status">${t("mcpApp.loading")}</p>` : nothing}
              ${
                this.catalog.error
                  ? html`<p role="alert">${this.catalog.error}</p>
                      <button class="btn" @click=${() => void this.catalog.refresh()}>
                        ${t("mcpApp.retry")}
                      </button>`
                  : nothing
              }
              ${!this.catalog.loading && !this.catalog.error && !rows.length ? html`<p>${t("mcpApp.empty")}</p>` : nothing}
              ${rows.map(
                ({ server, entry }) =>
                  html`<div class="mcp-app-catalog__entry">
                    <button class="btn" type="button" @click=${() => this.open(server, entry)}>
                      ${this.icon(server, entry)}<span
                        ><strong>${entry.title}</strong><small>${server.label}</small></span
                      ></button
                    >${entry.entrypoint.type === "global" && entry.entrypoint.quickAction ? html`<button class="btn btn--sm" type="button" @click=${() => this.open(server, entry, false, true)}>${entry.entrypoint.quickAction.title}</button>` : nothing}${server.settings ? html`<button type="button" class="btn btn--sm" @click=${() => this.open(server, entry, true)}>${t("mcpApp.settings")}</button>` : nothing}
                  </div>`,
              )}
              ${this.surface === "file" ? nothing : this.catalog.servers.filter((server) => server.settings && !this.entries(server).length).map((server) => html`<button class="btn" type="button" @click=${() => this.open(server, { toolName: server.settings!.readTool, title: server.label, resourceUri: "", entrypoint: { type: "settings" } }, true)}>${server.label} · ${t("mcpApp.settings")}</button>`)}
              ${this.catalog.onboarding.map((plugin) => html`<button class="btn" type="button" ?disabled=${this.onboardingBusy} @click=${() => void this.onboard(plugin.pluginId)}>${t("mcpApp.onboarding")} · ${plugin.title}</button>`)}
              ${!compact ? html`<button class="btn btn--sm" @click=${() => this.context?.navigate("mcp")}>${t("mcpApp.configure")}</button>` : nothing}
            </div>`
          : nothing
      }
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
    </section>`;
  }
}
if (!customElements.get("openclaw-mcp-app-catalog")) {
  customElements.define("openclaw-mcp-app-catalog", McpAppCatalog);
}
