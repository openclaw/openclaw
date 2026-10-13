import type {
  McpAppDiscoverResult,
  McpAppDiscoveredServer,
  McpAppExtensionTarget,
} from "../../../src/shared/mcp-app-extensions.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "./format-error.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";

const discoveryRequests = new WeakMap<
  GatewayBrowserClient,
  { invalidation?: object; pending: Map<string, Promise<McpAppDiscoverResult>> }
>();

type McpAppCatalogHost = {
  requestUpdate(): void;
  addController?(controller: McpAppCatalogController): void;
};

/** Presentation cache only. The Gateway remains the discovery and authorization owner. */
export class McpAppCatalogController {
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
    private host: McpAppCatalogHost,
    private context: () => ApplicationContext | undefined,
    private target: () => McpAppExtensionTarget,
    private prepareSession: () => boolean = () => false,
  ) {
    host.addController?.(this);
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
      const onChange = () => {
        this.sync();
        this.host.requestUpdate();
      };
      this.cleanup.push(context.gateway.subscribe(onChange));
      this.cleanup.push(context.agentSelection.subscribe(onChange));
      this.cleanup.push(
        context.gateway.subscribeEvents((event) => {
          if (event.event === "config.changed") {
            void this.refresh(event);
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
      void this.refresh(null);
    }
  }
  async refresh(invalidation: object | null = {}) {
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
    let discovery = discoveryRequests.get(client);
    if (!discovery) {
      discovery = { pending: new Map() };
      discoveryRequests.set(client, discovery);
    }
    // Gateway observers receive the same event object; retire old reads once
    // before any consumer awaits session preparation or issues its replacement.
    if (invalidation && discovery.invalidation !== invalidation) {
      discovery.invalidation = invalidation;
      discovery.pending.clear();
    }
    const pending = discovery.pending;
    const requestKey = JSON.stringify([scope, target.agentId, target.sessionKey]);
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
        const sessionTarget = { key: target.sessionKey, agentId: target.agentId };
        const described = await context.sessions.describe(sessionTarget);
        if (!current()) {
          return;
        }
        if (!described.session) {
          const session = await context.sessions.createResult(sessionTarget, {
            reconciliation: "background",
          });
          if (!current()) {
            return;
          }
          if (!session) {
            throw new Error(context.sessions.state.error ?? t("mcpApp.errors.sessionUnavailable"));
          }
          // A sibling's discovery may have observed the session before it existed.
          pending.delete(requestKey);
        }
        this.preparedSessionIdentity = this.identity;
      }
      let request = pending.get(requestKey);
      if (!request) {
        request = client.request<McpAppDiscoverResult>("mcp.app.discover", target);
        const release = () => {
          if (pending.get(requestKey) === request) {
            pending.delete(requestKey);
          }
        };
        void request.then(release, release);
        pending.set(requestKey, request);
      }
      const result = await request;
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
