import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../packages/gateway-protocol/src/control-ui-session-pull-requests.ts";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/index.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import { installRepositoryPresentation } from "./repository-presentation.test-support.ts";
type SidebarGatewayEventPublisher = (event: string, payload: unknown) => void;
const sidebarGatewayPublishers = new WeakMap<ApplicationGateway, SidebarGatewayEventPublisher>();

export function installSidebarRepositoryGateway(
  gateway: ApplicationGateway,
  publishEvent: SidebarGatewayEventPublisher,
) {
  const client = gateway.snapshot.client!;
  const hello = gateway.snapshot.hello!;
  const request = client.request.bind(client);
  client.request = <T = unknown>(
    ...args: Parameters<GatewayBrowserClient["request"]>
  ): Promise<T> =>
    args[0] === SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD
      ? Promise.resolve({ subscribed: true } as T)
      : request<T>(...args);
  hello.features = {
    ...hello.features,
    methods: [...(hello.features?.methods ?? []), SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
  };
  sidebarGatewayPublishers.set(gateway, publishEvent);
}

export function createSidebarPullRequestPublisher(currentGateway: () => ApplicationGateway | null) {
  return (key: string, summary: SessionCatalogPullRequestSummary | undefined) => {
    const gateway = currentGateway();
    const publishEvent = gateway && sidebarGatewayPublishers.get(gateway);
    if (!publishEvent) {
      throw new Error("Mount the sidebar before publishing its synthetic repository snapshot.");
    }
    publishEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: {
        [key]: {
          status: "ready",
          rateLimited: false,
          discardPrevious: true,
          pullRequests:
            summary?.numbers.map((number) => ({
              number,
              state: summary.state,
              owner: "synthetic",
              repo: "sidebar-fixture",
              branch: "feature/sidebar",
              title: "Synthetic sidebar pull request",
              url: `https://github.com/synthetic/sidebar-fixture/pull/${number}`,
            })) ?? [],
        },
      },
    });
  };
}

/** Sidebar fixtures render the plugin's real badge and read store, not a second host summary. */
export function installSidebarRepository(context: ApplicationContext) {
  if (!context.gateway.snapshot.client) {
    return;
  }
  const presentation = installRepositoryPresentation(context);
  const plugins = presentation.context.plugins;
  context.plugins.registrations = (kind) => plugins.registrations(kind);
  context.plugins.reportError = (pluginId, error) => plugins.reportError(pluginId, error);
  context.plugins.subscribe = (listener) => plugins.subscribe(listener);
  context.plugins.selectedReplacement = (surface) => plugins.selectedReplacement(surface);
}
