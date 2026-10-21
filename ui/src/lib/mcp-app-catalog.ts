import { createEffect, createMemo, createStore, onCleanup } from "solid-js";
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
import { canCallGatewayMethod } from "./gateway-methods.ts";
import { projectAgentSelection, projectGateway } from "./reactive/application.ts";

const discoveryRequests = new WeakMap<
  GatewayBrowserClient,
  Map<string, Promise<McpAppDiscoverResult>>
>();

/** Presentation cache only. The Gateway remains the discovery and authorization owner. */
export function createMcpAppCatalog(
  context: ApplicationContext,
  target: () => McpAppExtensionTarget,
  prepareSession: () => boolean = () => false,
) {
  const gateway = projectGateway(context.gateway);
  const selection = projectAgentSelection(context.agentSelection);
  const [state, setState] = createStore<{
    servers: McpAppDiscoveredServer[];
    onboarding: NonNullable<McpAppDiscoverResult["onboarding"]>;
    loading: boolean;
    error: string | null;
  }>({ servers: [], onboarding: [], loading: false, error: null }, { shallow: true });
  let generation = 0;
  let identity = "";
  let identityClient: GatewayBrowserClient | null = null;
  let preparedSessionIdentity = "";
  let targetRequest = new AbortController();
  const available = () => {
    const snapshot = gateway.read().snapshot;
    return (
      canCallGatewayMethod(snapshot, "mcp.app.discover", "operator.write") ||
      canCallGatewayMethod(snapshot, "mcp.app.discover", "operator.sessions.write")
    );
  };
  const discoveryIdentity = createMemo(() => {
    gateway.read();
    selection.read();
    const value = target();
    return JSON.stringify([
      gatewayPresentationScope(context.gateway).key,
      value.agentId,
      value.sessionKey,
    ]);
  });
  const discoveryBinding = createMemo(
    () =>
      [
        discoveryIdentity(),
        gateway.read().snapshot.phase,
        gateway.read().snapshot.hello,
        gateway.read().snapshot.client,
        available(),
      ] as const,
    { equals: (a, b) => a.every((value, index) => value === b[index]) },
  );
  createEffect(discoveryBinding, ([value, phase, , client, canDiscover]) => {
    const changed = identity !== value || identityClient !== client;
    targetRequest.abort();
    targetRequest = new AbortController();
    identity = value;
    identityClient = client;
    preparedSessionIdentity = "";
    generation++;
    setState((draft) => {
      if (changed || (phase === "connected" && !canDiscover)) {
        draft.servers = [];
        draft.onboarding = [];
      }
      draft.error = null;
      draft.loading = false;
    });
    void refresh();
  });
  const unsubscribe = context.gateway.subscribeEvents((event) => {
    if (event.event === "config.changed") {
      void refresh();
    }
  });
  onCleanup(() => {
    targetRequest.abort();
    unsubscribe();
  });

  async function refresh() {
    const { signal } = targetRequest;
    const client = context.gateway.snapshot.client;
    const destination = target();
    if (
      !client ||
      context.gateway.snapshot.phase !== "connected" ||
      !available() ||
      !destination.sessionKey
    ) {
      return;
    }
    const requestGeneration = ++generation;
    const connectionGeneration = client.connectionGeneration;
    const hello = context.gateway.snapshot.hello;
    const scope = gatewayPresentationScope(context.gateway).key;
    let pending = discoveryRequests.get(client);
    if (!pending) {
      pending = new Map();
      discoveryRequests.set(client, pending);
    }
    // A config change during discovery may show the older catalog until the next refresh.
    const requestKey = JSON.stringify([
      scope,
      connectionGeneration,
      destination.agentId,
      destination.sessionKey,
    ]);
    setState((draft) => {
      draft.loading = true;
      draft.error = null;
    });
    const current = () =>
      !signal.aborted &&
      requestGeneration === generation &&
      client === context.gateway.snapshot.client &&
      client.connectionGeneration === connectionGeneration &&
      context.gateway.snapshot.phase === "connected" &&
      hello === context.gateway.snapshot.hello &&
      scope === gatewayPresentationScope(context.gateway).key &&
      JSON.stringify(destination) === JSON.stringify(target());
    try {
      if (prepareSession() && preparedSessionIdentity !== identity) {
        const sessionTarget = { key: destination.sessionKey, agentId: destination.agentId };
        const described = await context.sessions.describe(sessionTarget);
        if (!current()) {
          return;
        }
        if (!described.session) {
          const session = await context.sessions.createResult(sessionTarget, {
            reconciliation: "background",
            signal,
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
        preparedSessionIdentity = identity;
      }
      let request = pending.get(requestKey);
      if (!request) {
        request = client.request<McpAppDiscoverResult>("mcp.app.discover", destination);
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
        setState((draft) => {
          draft.servers = result.servers;
          draft.onboarding = result.onboarding ?? [];
        });
      }
    } catch (error) {
      if (current()) {
        setState((draft) => {
          draft.error = formatUiError(error);
        });
      }
    } finally {
      if (current()) {
        setState((draft) => {
          draft.loading = false;
        });
      }
    }
  }
  return () => ({
    ...state,
    // Consumers can retain a launch during render, before the refresh effect clears old results.
    ...(discoveryIdentity() === identity && gateway.read().snapshot.client === identityClient
      ? {}
      : { servers: [], onboarding: [], loading: false, error: null }),
    available: available(),
    visible:
      available() ||
      (gateway.read().snapshot.phase !== "connected" &&
        (state.servers.length > 0 || state.onboarding.length > 0)),
    refresh,
  });
}
