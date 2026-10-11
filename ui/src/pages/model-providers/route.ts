import { definePage, type RouteLoaderOptions } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ModelProvidersData } from "./load.ts";

export type ModelProvidersRouteData = {
  /** Gateway source that owned the route preload. */
  gateway: ApplicationContext["gateway"];
  /** Exact Gateway snapshot captured before the preload began. */
  gatewaySnapshot: ApplicationContext["gateway"]["snapshot"];
  data: ModelProvidersData;
  /** Client the loader fetched from; null when it ran disconnected. */
  client: ApplicationContext["gateway"]["snapshot"]["client"];
  /** Concrete agent whose credential store populated the auth snapshot. */
  agentId: string | null;
  selectionIntentRevision: number;
  /** An explicit connection entry from a saved setup link. */
  connect?: boolean;
  provider?: string;
};

async function loadModelProvidersRouteData(
  context: Pick<ApplicationContext, "gateway" | "agents" | "settingsAgentSelection">,
  options: RouteLoaderOptions,
): Promise<ModelProvidersRouteData> {
  const search = new URLSearchParams(options.location.search);
  const connect = search.get("connect") === "1";
  const provider = search.get("provider")?.trim() ?? "";
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const selection = context.settingsAgentSelection;
  const selectionIntentRevision = selection.intentRevision;
  const owner = { gateway, gatewaySnapshot, selectionIntentRevision, connect, provider };
  let agentId = selection.state.selectedId;
  const { EMPTY_MODEL_PROVIDERS_DATA, loadModelProvidersData } = await import("./load.ts");
  const client = gatewaySnapshot.phase === "connected" ? gatewaySnapshot.client : null;
  // Both awaits can outlive the route or its Gateway/agent owner. Metadata-only
  // snapshot publications preserve the client and hello, so remain valid.
  const isCurrent = () => {
    const current = gateway.snapshot;
    return (
      options.shouldRun() &&
      current.phase === "connected" &&
      current.client === gatewaySnapshot.client &&
      current.hello === gatewaySnapshot.hello &&
      selection.intentRevision === selectionIntentRevision &&
      selection.state.selectedId === agentId
    );
  };
  if (client && isCurrent()) {
    if (!agentId) {
      await context.agents.ensureList();
      // The selection owner validates pending cold-link intent against the roster.
      agentId = selection.state.selectedId;
    }
    if (agentId && isCurrent()) {
      return {
        ...owner,
        data: await loadModelProvidersData(client, { agentId, signal: options.signal }),
        client,
        agentId,
      };
    }
  }
  return {
    ...owner,
    data: EMPTY_MODEL_PROVIDERS_DATA,
    client: null,
    agentId,
  };
}

export const page = definePage({
  ...routePageSpec("model-providers"),
  loaderDeps: (_context, location) => location.search,
  loader: loadModelProvidersRouteData,
  component: () =>
    import("./model-providers-page.ts").then(() => ({
      header: true,
      render: (data: ModelProvidersRouteData | undefined, loaderPending = false) =>
        html`<openclaw-model-providers-page
          .routeData=${data}
          .loaderPending=${loaderPending}
        ></openclaw-model-providers-page>`,
    })),
});
