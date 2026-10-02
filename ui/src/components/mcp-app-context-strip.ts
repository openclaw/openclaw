import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { t } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  readMcpAppContexts,
  publishMcpAppContext,
  subscribeMcpAppContexts,
  mcpAppContextItemTitle,
  mcpAppContextThumbnail,
  type McpAppContextEntry,
  type McpAppContextState,
} from "../lib/mcp-app-context.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { icons } from "./icons.ts";
import "../styles/mcp-app-extensions.css";

registerMcpAppEnglish();

export class McpAppContextStrip extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId = "";
  @state() private error: string | null = null;
  @state() private pending = new Set<string>();
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => {
        const refreshes = new Map<string, number>();
        const stop = gateway.subscribe(notify);
        const stopEvents = gateway.subscribeEvents((event) => {
          if (event.event !== "mcp.app.hostContextChanged") {
            return;
          }
          const payload = event.payload;
          if (
            !payload ||
            typeof payload !== "object" ||
            !("viewId" in payload) ||
            typeof payload.viewId !== "string"
          ) {
            return;
          }
          const client = gateway.snapshot.client;
          const entry = readMcpAppContexts(client, this.sessionKey, this.agentId).find(
            (item) => item.viewId === payload.viewId,
          );
          if (!client || !entry) {
            return;
          }
          const generation = (refreshes.get(entry.viewId) ?? 0) + 1;
          refreshes.set(entry.viewId, generation);
          void client
            .request<{ state: McpAppContextState }>("mcp.app.modelContext", {
              sessionKey: entry.sessionKey,
              agentId: entry.agentId,
              viewId: entry.viewId,
            })
            .then((result) => {
              if (
                this.isConnected &&
                gateway.snapshot.client === client &&
                refreshes.get(entry.viewId) === generation
              ) {
                publishMcpAppContext(client, { ...entry, state: result.state });
              }
            })
            .catch(() => {
              if (
                this.isConnected &&
                gateway.snapshot.client === client &&
                refreshes.get(entry.viewId) === generation
              ) {
                publishMcpAppContext(client, { ...entry, state: null });
              }
            });
        });
        return () => {
          stop();
          stopEvents();
          refreshes.clear();
        };
      },
    )
    .watch(
      () => this.context?.gateway.snapshot.client,
      (client, notify) => subscribeMcpAppContexts(client, notify),
    );
  private async removeItem(entry: McpAppContextEntry, index?: number) {
    const context = this.context;
    const client = context?.gateway.snapshot.client;
    const snapshot = entry.state;
    if (!context || !client || !snapshot || context.gateway.snapshot.phase !== "connected") {
      return;
    }
    const scope = gatewayPresentationScope(context.gateway).key;
    const sessionKey = this.sessionKey;
    this.pending = new Set([...this.pending, entry.viewId]);
    this.error = null;
    try {
      const result = await client.request<{ state: McpAppContextState }>(
        "mcp.app.removeModelContext",
        {
          sessionKey: entry.sessionKey,
          agentId: entry.agentId,
          viewId: entry.viewId,
          updateId: snapshot.updateId,
          ...(index !== undefined ? { index } : {}),
        },
      );
      if (
        this.isConnected &&
        context.gateway.snapshot.client === client &&
        gatewayPresentationScope(context.gateway).key === scope &&
        sessionKey === this.sessionKey
      ) {
        const rendered = readMcpAppContexts(client, sessionKey, this.agentId).find(
          (item) => item.viewId === entry.viewId,
        );
        if (rendered?.state?.updateId === snapshot.updateId) {
          publishMcpAppContext(client, { ...entry, state: result.state });
        }
      }
    } catch (error) {
      if (
        this.isConnected &&
        context.gateway.snapshot.client === client &&
        sessionKey === this.sessionKey
      ) {
        this.error = formatUiError(error);
      }
    } finally {
      this.pending = new Set([...this.pending].filter((id) => id !== entry.viewId));
    }
  }
  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override render() {
    const entries = readMcpAppContexts(
      this.context?.gateway.snapshot.client ?? null,
      this.sessionKey,
      this.agentId,
    );
    if (!entries.length) {
      return nothing;
    }
    return html`<section class="mcp-app-context" aria-label=${t("mcpApp.contextTitle")}>
      <div class="mcp-app-context__header" title=${t("mcpApp.contextDescription")}>
        ${icons.puzzle} ${t("mcpApp.contextTitle")}
      </div>
      ${entries.map(
        (entry) =>
          html`<div class="mcp-app-context__items">
            ${(entry.state?.content ?? []).map((content, index) => {
              const kind =
                content.type === "image"
                  ? "mcpApp.imageContent"
                  : content.type === "text"
                    ? "mcpApp.textContent"
                    : "mcpApp.resourceContent";
              const title = mcpAppContextItemTitle(content, `${entry.title} · ${t(kind)}`);
              const thumbnail = mcpAppContextThumbnail(content);
              return html`<div class="mcp-app-context__item">
                ${thumbnail ? html`<img src=${thumbnail} alt=${title} referrerpolicy="no-referrer" loading="lazy" />` : icons.fileText}<span
                  class="mcp-app-context__label"
                  title=${title}
                  >${title}</span
                ><button
                  type="button"
                  ?disabled=${this.pending.has(entry.viewId)}
                  aria-label=${t("mcpApp.removeContext", { title })}
                  @click=${() => void this.removeItem(entry, index)}
                >
                  ${icons.x}
                </button>
              </div>`;
            })}${entry.state?.structuredContent ? html`<div class="mcp-app-context__item"><span>${entry.title}</span><button type="button" ?disabled=${this.pending.has(entry.viewId)} aria-label=${t("mcpApp.removeContext", { title: entry.title })} @click=${() => void this.removeItem(entry)}>${icons.x}</button></div>` : nothing}
          </div>`,
      )}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
    </section>`;
  }
}
if (!customElements.get("openclaw-mcp-app-context-strip")) {
  customElements.define("openclaw-mcp-app-context-strip", McpAppContextStrip);
}
