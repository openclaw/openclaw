import { onTestFinished } from "vitest";
import { createRepositoryBrowserRuntime } from "../../../extensions/github-repositories/browser/repository-runtime.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../extensions/github-repositories/browser/session-pull-requests.ts";
import { createSidebarAccessoryMount } from "../../../extensions/github-repositories/browser/sidebar-accessory.tsx";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../packages/gateway-protocol/src/control-ui-session-pull-requests.ts";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import type {
  ControlUiContributions,
  ControlUiRegistration,
} from "../plugins/control-ui-capability.ts";
import { createControlUiPluginHost } from "../plugins/control-ui-host.ts";
import {
  type ControlUiPluginOwner,
  ControlUiPluginRuntime,
} from "../plugins/control-ui-runtime.ts";

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
  const abort = new AbortController();
  const owner = {
    client: context.gateway.snapshot.client,
    abort,
    descriptor: { pluginId: "github-repositories" },
    disposers: new Set<() => void>(),
  } as Omit<ControlUiPluginOwner, "host">;
  const runtime = new ControlUiPluginRuntime(() => context);
  // This fixture admits one fixed contribution without loading a browser asset catalog.
  runtime.isCurrent = (candidate) => candidate === owner && !abort.signal.aborted;
  runtime.reportError = (_pluginId, error) => {
    throw error;
  };
  const host = createControlUiPluginHost(() => context, runtime, owner);
  const repository = createRepositoryBrowserRuntime(host);
  const registrations: {
    [K in keyof ControlUiContributions]: ControlUiRegistration<ControlUiContributions[K]>[];
  } = {
    pages: [],
    navigation: [],
    panels: [],
    actions: [],
    accessories: [
      {
        key: "github-repositories/repository-row",
        pluginId: "github-repositories",
        value: {
          id: "repository-row",
          placement: "session-row",
          mount: createSidebarAccessoryMount(repository),
        },
        host,
        signal: abort.signal,
      },
    ],
    inlineViews: [],
    textReferences: [],
    widgets: [],
    replacements: [],
  };
  context.plugins.registrations = (kind) => registrations[kind];
  context.plugins.reportError = (pluginId, error) => runtime.reportError(pluginId, error);
  onTestFinished(() => {
    abort.abort();
    owner.disposers.forEach((dispose) => dispose());
    owner.disposers.clear();
    runtime.dispose();
  });
}
