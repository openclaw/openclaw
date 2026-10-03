import type { ReactiveController, ReactiveControllerHost } from "lit";
import type {
  McpAppDiscoverResult,
  McpAppDiscoveredServer,
  McpAppExtensionTarget,
} from "../../../src/shared/mcp-app-extensions.js";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "./format-error.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";

/** Presentation cache only. The Gateway remains the discovery and authorization owner. */
export class McpAppCatalogController implements ReactiveController {
  servers: McpAppDiscoveredServer[] = [];
  onboarding: NonNullable<McpAppDiscoverResult["onboarding"]> = [];
  loading = false;
  error: string | null = null;
  private generation = 0;
  private identity = "";
  private preparedSessionIdentity = "";
  private cleanup: (() => void)[] = [];
  private connected = false;
  constructor(
    private host: ReactiveControllerHost,
    private context: () => ApplicationContext | undefined,
    private target: () => McpAppExtensionTarget,
    private prepareSession: () => boolean = () => false,
  ) {
    host.addController(this);
  }
  get available() {
    return (
      isGatewayMethodAdvertised(this.context()?.gateway.snapshot ?? {}, "mcp.app.discover") === true
    );
  }
  hostConnected() {
    this.connected = true;
  }
  hostUpdate() {
    const context = this.context();
    if (!context) {
      return;
    }
    if (!this.cleanup.length) {
      this.cleanup.push(
        context.gateway.subscribe(() => {
          this.sync();
          this.host.requestUpdate();
        }),
      );
      this.cleanup.push(
        context.agentSelection.subscribe(() => {
          this.sync();
          this.host.requestUpdate();
        }),
      );
      this.cleanup.push(
        context.gateway.subscribeEvents((event) => {
          if (event.event === "config.changed") {
            void this.refresh();
          }
        }),
      );
    }
    this.sync();
  }
  hostDisconnected() {
    this.connected = false;
    this.generation++;
    this.identity = "";
    this.preparedSessionIdentity = "";
    for (const cleanup of this.cleanup.splice(0)) {
      cleanup();
    }
  }
  private sync() {
    const context = this.context();
    if (!context) {
      return;
    }
    const gateway = context.gateway;
    const target = this.target();
    const identity = JSON.stringify([
      gatewayPresentationScope(gateway).key,
      gateway.snapshot.phase === "connected",
      this.available,
      target.agentId,
      target.sessionKey,
    ]);
    if (identity === this.identity) {
      return;
    }
    this.identity = identity;
    this.generation++;
    this.servers = [];
    this.onboarding = [];
    this.error = null;
    this.loading = false;
    if (gateway.snapshot.phase === "connected" && this.available && target.sessionKey) {
      void this.refresh();
    }
  }
  async refresh() {
    const context = this.context();
    const client = context?.gateway.snapshot.client;
    const target = this.target();
    if (
      !context ||
      !client ||
      context.gateway.snapshot.phase !== "connected" ||
      !this.available ||
      !target.sessionKey
    ) {
      return;
    }
    const generation = ++this.generation;
    const scope = gatewayPresentationScope(context.gateway).key;
    this.loading = true;
    this.error = null;
    this.host.requestUpdate();
    const current = () =>
      this.connected &&
      generation === this.generation &&
      client === context.gateway.snapshot.client &&
      scope === gatewayPresentationScope(context.gateway).key &&
      JSON.stringify(target) === JSON.stringify(this.target());
    try {
      if (this.prepareSession() && this.preparedSessionIdentity !== this.identity) {
        const described = await context.sessions.describe({
          key: target.sessionKey,
          agentId: target.agentId,
        });
        if (!current()) {
          return;
        }
        if (!described.session) {
          const session = await context.sessions.createResult(
            { key: target.sessionKey, agentId: target.agentId },
            { reconciliation: "background" },
          );
          if (!current()) {
            return;
          }
          if (!session) {
            throw new Error(context.sessions.state.error ?? t("mcpApp.errors.sessionUnavailable"));
          }
        }
        this.preparedSessionIdentity = this.identity;
      }
      const result = await client.request<McpAppDiscoverResult>("mcp.app.discover", target);
      if (current()) {
        this.servers = result.servers;
        this.onboarding = result.onboarding ?? [];
      }
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.loading = false;
        this.host.requestUpdate();
      }
    }
  }
}
