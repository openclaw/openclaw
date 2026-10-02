import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type {
  McpAppSettings,
  McpAppSettingsParams,
} from "../../../src/shared/mcp-app-extensions.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { t } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../lib/format-error.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import type { McpAppOpenDetail } from "./mcp-app-launch.ts";
import { renderMcpAppSettings } from "./mcp-app-settings.ts";
import { McpAppUnmountGate } from "./mcp-app-unmount.ts";
import "../styles/mcp-app-extensions.css";

registerMcpAppEnglish();

export class McpAppPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  @property({ attribute: false }) launch?: McpAppOpenDetail;
  @state() private viewId = "";
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private notice = "";
  @state() private settings: McpAppSettings | null = null;
  @state() private values: McpAppSettings["values"] = {};
  private generation = 0;
  private ownerScope = -1;
  private launchIdentity = "";
  private currentLaunchIdentity() {
    const launch = this.launch;
    return JSON.stringify([
      launch?.sessionKey,
      launch?.agentId,
      launch?.serverName,
      launch?.entrypoint.toolName,
      launch?.filePath,
      launch?.settings,
      launch?.quickAction,
    ]);
  }
  private readonly unmount = new McpAppUnmountGate(this);
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
  );
  override willUpdate(changed: PropertyValues) {
    const scope = this.context ? gatewayPresentationScope(this.context.gateway).key : -1;
    const identity = this.currentLaunchIdentity();
    if ((changed.has("launch") && identity !== this.launchIdentity) || scope !== this.ownerScope) {
      this.launchIdentity = identity;
      this.ownerScope = scope;
      this.generation++;
      this.viewId = "";
      this.settings = null;
      this.busy = false;
      this.error = null;
      if (
        this.launch &&
        this.context &&
        this.launch.owner === this.context.gateway.snapshot.client
      ) {
        void this.open();
      }
    }
  }
  private async operation<T>(
    run: (
      client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>,
      launch: McpAppOpenDetail,
    ) => Promise<T>,
    commit: (result: T) => void,
  ) {
    const context = this.context;
    const launch = this.launch;
    const client = context?.gateway.snapshot.client;
    if (
      !context ||
      !launch ||
      !client ||
      client !== launch.owner ||
      context.gateway.snapshot.phase !== "connected"
    ) {
      this.error = t("mcpApp.disconnected");
      return;
    }
    const generation = ++this.generation;
    const identity = this.currentLaunchIdentity();
    const scope = gatewayPresentationScope(context.gateway).key;
    const current = () =>
      this.isConnected &&
      generation === this.generation &&
      this.currentLaunchIdentity() === identity &&
      context.gateway.snapshot.client === client &&
      gatewayPresentationScope(context.gateway).key === scope;
    this.busy = true;
    this.error = null;
    this.notice = "";
    try {
      const result = await run(client, launch);
      if (current()) {
        commit(result);
      }
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.busy = false;
      }
    }
  }
  private async open() {
    if (this.launch?.settings) {
      await this.readSettings();
      return;
    }
    await this.operation(
      async (client, launch) => {
        const registration = await import("./mcp-app-view-registration.ts");
        registration.registerMcpAppView();
        if (
          this.launch?.sessionKey !== launch.sessionKey ||
          this.launch?.serverName !== launch.serverName ||
          this.launch?.entrypoint.toolName !== launch.entrypoint.toolName ||
          client !== this.context?.gateway.snapshot.client ||
          !this.isConnected
        ) {
          throw new Error(t("mcpApp.disconnected"));
        }
        return await client.request<{ viewId?: string; toolResult?: { isError?: boolean } }>(
          "mcp.app.launch",
          {
            sessionKey: launch.sessionKey,
            agentId: launch.agentId,
            serverName: launch.serverName,
            toolName: launch.entrypoint.toolName,
            entrypointType: launch.entrypoint.entrypoint.type,
            ...(launch.quickAction ? { quickAction: true } : {}),
            ...(launch.filePath ? { filePath: launch.filePath } : {}),
            ...(launch.deepLink ? { deepLink: launch.deepLink } : {}),
          },
        );
      },
      (result) => {
        if (result.toolResult?.isError || (!result.viewId && !result.toolResult)) {
          throw new Error(t("mcpApp.errors.requestFailed"));
        }
        if (result.viewId) {
          this.viewId = result.viewId;
        } else {
          this.notice = t("mcpApp.actionComplete");
        }
      },
    );
  }
  private params(action: McpAppSettingsParams["action"]): McpAppSettingsParams {
    return {
      sessionKey: this.launch!.sessionKey,
      agentId: this.launch!.agentId,
      serverName: this.launch!.serverName,
      action,
    };
  }
  private async readSettings() {
    await this.operation(
      (client) => client.request<McpAppSettings>("mcp.app.settings", this.params("read")),
      (result) => {
        this.settings = result;
        this.values = { ...result.values };
      },
    );
  }
  private async saveSettings() {
    const set = Object.fromEntries(
      Object.entries(this.values).filter(([key, value]) => this.settings?.values[key] !== value),
    );
    if (!Object.keys(set).length) {
      return;
    }
    await this.operation(
      async (client) => {
        const result = await client.request<{ toolResult?: { isError?: boolean } }>(
          "mcp.app.settings",
          { ...this.params("update"), arguments: { set } },
        );
        if (result.toolResult?.isError) {
          throw new Error(t("mcpApp.errors.requestFailed"));
        }
        return await client.request<McpAppSettings>("mcp.app.settings", this.params("read"));
      },
      (result) => {
        this.settings = result;
        this.values = { ...result.values };
        this.notice = t("mcpApp.settingsSaved");
      },
    );
  }
  private async runTool(toolName: string) {
    await this.operation(
      async (client, launch) => {
        const registration = await import("./mcp-app-view-registration.ts");
        registration.registerMcpAppView();
        if (
          this.launch !== launch ||
          this.context?.gateway.snapshot.client !== client ||
          !this.isConnected
        ) {
          throw new Error(t("mcpApp.disconnected"));
        }
        return client.request<{ viewId?: string; toolResult?: { isError?: boolean } }>(
          "mcp.app.settings",
          { ...this.params("tool"), toolName },
        );
      },
      (result) => {
        if (result.toolResult?.isError) {
          this.error = t("mcpApp.errors.requestFailed");
          return;
        }
        if (result.viewId) {
          this.settings = null;
          this.viewId = result.viewId;
        } else {
          this.notice = t("mcpApp.actionComplete");
        }
      },
    );
  }
  override disconnectedCallback() {
    this.generation++;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }
  override render() {
    const launch = this.launch;
    if (!launch) {
      return nothing;
    }
    return html`<section class="mcp-app-panel">
      <div class="mcp-app-panel__toolbar">
        <strong>${launch.entrypoint.title}</strong><span class="muted">${launch.serverName}</span>
        ${
          launch.settings && !this.settings
            ? html`<button
                class="btn btn--sm"
                ?disabled=${this.busy}
                @click=${() => {
                  this.viewId = "";
                  void this.readSettings();
                }}
              >
                ${t("mcpApp.settings")}
              </button>`
            : nothing
        }
      </div>
      ${this.busy ? html`<p role="status">${t("mcpApp.loading")}</p>` : nothing}
      ${
        this.error
          ? html`<p role="alert">${this.error}</p>
              <button class="btn" @click=${() => void this.open()}>${t("mcpApp.retry")}</button>`
          : nothing
      }
      ${this.notice ? html`<p role="status">${this.notice}</p>` : nothing}
      ${
        this.settings
          ? renderMcpAppSettings({
              settings: this.settings,
              values: this.values,
              busy: this.busy,
              onChange: (key, value) => {
                this.values = { ...this.values, [key]: value };
              },
              onSave: () => void this.saveSettings(),
              onTool: (name) => void this.runTool(name),
            })
          : nothing
      }
      ${this.unmount.render(
        this.viewId,
        () =>
          this.viewId
            ? keyed(
                this.viewId,
                html`<mcp-app-view
                  .sessionKey=${launch.sessionKey}
                  .agentId=${launch.agentId ?? ""}
                  .viewId=${this.viewId}
                  .title=${launch.entrypoint.title}
                  .deepLink=${launch.deepLink}
                ></mcp-app-view>`,
              )
            : nothing,
        () => [this],
      )}
    </section>`;
  }
}
if (!customElements.get("openclaw-mcp-app-panel")) {
  customElements.define("openclaw-mcp-app-panel", McpAppPanel);
}
