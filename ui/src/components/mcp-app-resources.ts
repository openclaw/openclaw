import { consume } from "@lit/context";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  McpAppMentionResult,
  McpAppResourceLink,
} from "../../../src/shared/mcp-app-extensions.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { t } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../lib/format-error.ts";
import { McpAppCatalogController } from "../lib/mcp-app-catalog.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
registerMcpAppEnglish();

export const MCP_APP_RESOURCE_MENTION_EVENT = "openclaw-mcp-app-resource-mention";
export type McpAppResourceMentionDetail = {
  sessionKey: string;
  agentId: string;
  serverName: string;
  resource: McpAppResourceLink;
};

export class McpAppResources extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId = "";
  @state() private expanded = false;
  @state() private serverName = "";
  @state() private query = "";
  @state() private resources: McpAppResourceLink[] = [];
  @state() private busy = false;
  @state() private searched = false;
  @state() private error: string | null = null;
  private generation = 0;
  private scope = -1;
  private readonly catalog = new McpAppCatalogController(
    this,
    () => this.context,
    () => ({ sessionKey: this.sessionKey, agentId: this.agentId }),
  );
  override willUpdate(changed: PropertyValues) {
    const scope = this.context ? gatewayPresentationScope(this.context.gateway).key : -1;
    if (changed.has("sessionKey") || changed.has("agentId") || scope !== this.scope) {
      this.scope = scope;
      this.generation++;
      this.resources = [];
      this.error = null;
      this.searched = false;
      this.busy = false;
    }
  }
  private async search() {
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.serverName) {
      return;
    }
    const generation = ++this.generation;
    const scope = this.scope;
    const { sessionKey, agentId, serverName } = this;
    const current = () =>
      this.isConnected &&
      this.generation === generation &&
      this.context?.gateway.snapshot.client === client &&
      this.scope === scope;
    this.busy = true;
    this.error = null;
    this.resources = [];
    try {
      const result = await client.request<McpAppMentionResult>("mcp.app.mention", {
        sessionKey,
        agentId,
        serverName,
        query: this.query,
      });
      if (current()) {
        this.resources = result.resources;
        this.searched = true;
      }
    } catch (error) {
      if (current()) {
        this.error =
          asOptionalRecord(asOptionalRecord(error)?.details)?.code ===
          "MCP_APP_UNSUPPORTED_MENTION_RESULT"
            ? t("mcpApp.errors.unsupportedResources")
            : formatUiError(error);
      }
    } finally {
      if (current()) {
        this.busy = false;
      }
    }
  }
  private attach(resource: McpAppResourceLink) {
    if (
      this.context?.gateway.snapshot.phase !== "connected" ||
      !this.resources.includes(resource)
    ) {
      return;
    }
    const claimed = !this.dispatchEvent(
      new CustomEvent<McpAppResourceMentionDetail>(MCP_APP_RESOURCE_MENTION_EVENT, {
        bubbles: true,
        composed: true,
        cancelable: true,
        detail: {
          sessionKey: this.sessionKey,
          agentId: this.agentId,
          serverName: this.serverName,
          resource,
        },
      }),
    );
    if (claimed) {
      this.expanded = false;
    } else {
      this.error = t("mcpApp.errors.mountUnavailable");
    }
  }
  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }
  override render() {
    const servers = this.catalog.servers.filter((server) => server.mentionTool);
    if (!servers.length) {
      return nothing;
    }
    if (!servers.some((server) => server.serverName === this.serverName)) {
      this.serverName = servers[0]!.serverName;
    }
    return html`<section class="mcp-app-resources">
      <button
        type="button"
        class="btn btn--sm"
        aria-expanded=${String(this.expanded)}
        @click=${() => {
          this.expanded = !this.expanded;
        }}
      >
        ${icons.link} ${t("mcpApp.resources")}
      </button>
      ${
        this.expanded
          ? html`<p class="muted">${t("mcpApp.resourceDescription")}</p>
              <form
                class="mcp-app-resources__search"
                @submit=${(event: SubmitEvent) => {
                  event.preventDefault();
                  void this.search();
                }}
              >
                <select
                  aria-label=${t("mcpApp.title")}
                  .value=${this.serverName}
                  ?disabled=${this.busy}
                  @change=${(event: Event) => {
                    if (!(event.currentTarget instanceof HTMLSelectElement)) {
                      return;
                    }
                    this.serverName = event.currentTarget.value;
                    this.generation++;
                    this.resources = [];
                    this.searched = false;
                  }}
                >
                  ${servers.map((server) => html`<option value=${server.serverName}>${server.label}</option>`)}
                </select>
                <input
                  type="search"
                  aria-label=${t("mcpApp.resourceSearch")}
                  placeholder=${t("mcpApp.resourceQuery")}
                  .value=${this.query}
                  @input=${(event: Event) => {
                    if (!(event.currentTarget instanceof HTMLInputElement)) {
                      return;
                    }
                    this.query = event.currentTarget.value;
                    this.generation++;
                    this.busy = false;
                    this.resources = [];
                    this.searched = false;
                  }}
                />
                <button class="btn" type="submit" ?disabled=${this.busy}>
                  ${t("mcpApp.resourceSearch")}
                </button>
              </form>
              <div class="mcp-app-resources__results">
                ${this.resources.map((resource) => html`<button type="button" class="btn mcp-app-resources__result" ?disabled=${this.busy} @click=${() => this.attach(resource)}><span>${resource.title || resource.name}</span><small>${resource.description || resource.uri}</small></button>`)}
              </div>
              ${this.searched && !this.resources.length ? html`<p role="status">${t("mcpApp.noResources")}</p>` : nothing} `
          : nothing
      }
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
    </section>`;
  }
}
if (!customElements.get("openclaw-mcp-app-resources")) {
  customElements.define("openclaw-mcp-app-resources", McpAppResources);
}
