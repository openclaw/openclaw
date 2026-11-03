import { onTestFinished, vi } from "vitest";
import {
  installRepositoryServices,
  readRepositoryServices,
  type RepositoryServices,
} from "../../extensions/github-repositories/account-runtime-api.js";
import repositoryPlugin from "../../extensions/github-repositories/index.js";
import repositoryManifest from "../../extensions/github-repositories/openclaw.plugin.json" with { type: "json" };
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createTestPluginServiceScheduler } from "../plugin-sdk/plugin-test-api.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { getGatewayServiceLifetime } from "../plugins/runtime/gateway-service-owner.js";
import { startPluginServices } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createRepositorySessionReadHost } from "./control-ui-session-pr-runtime.js";
import type { RepositorySessionPresentation } from "./repository-session-read.types.js";
import { createRepositorySources } from "./repository-sources.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

/** Synthetic HTTP transport still uses the real Gateway-owned account service lookup. */
export function installGitHubAccountFixture(
  context: GatewayRequestContext,
  oauth: RepositoryServices["oauth"],
  publication?: Partial<NonNullable<RepositoryServices["publication"]>>,
) {
  context.resolveGatewayContext ??= () => context;
  const stop = installRepositoryServices(
    getGatewayServiceLifetime(context),
    { oauth, ...(publication ? { publication: publicationFixtureApi(publication) } : {}) },
    new AbortController().signal,
  );
  onTestFinished(stop);
  return stop;
}
/** Authorization fixtures supply their native operation under the real service lookup. */
function publicationFixtureApi(
  publication: Partial<NonNullable<RepositoryServices["publication"]>>,
): NonNullable<RepositoryServices["publication"]> {
  const unavailable = (): never => {
    throw new Error("Unexpected publication operation in authorization fixture");
  };
  return {
    supportsOrigin: (originUrl) => publication.supportsOrigin?.(originUrl) ?? false,
    performPullRequestAction: (...args) =>
      publication.performPullRequestAction
        ? publication.performPullRequestAction(...args)
        : unavailable(),
    inspectPullRequest: (...args) =>
      publication.inspectPullRequest ? publication.inspectPullRequest(...args) : unavailable(),
    preparePullRequest: (...args) =>
      publication.preparePullRequest ? publication.preparePullRequest(...args) : unavailable(),
    refreshBase: (...args) =>
      publication.refreshBase ? publication.refreshBase(...args) : unavailable(),
    requestForSessionV2: (...args) =>
      publication.requestForSessionV2 ? publication.requestForSessionV2(...args) : unavailable(),
    requestPersonalForSessionV2: (...args) =>
      publication.requestPersonalForSessionV2
        ? publication.requestPersonalForSessionV2(...args)
        : unavailable(),
    confirmPersonalV2: (...args) =>
      publication.confirmPersonalV2 ? publication.confirmPersonalV2(...args) : unavailable(),
    preparePersonalStatus: (...args) =>
      publication.preparePersonalStatus
        ? publication.preparePersonalStatus(...args)
        : unavailable(),
    personalStatusAsync: (...args) =>
      publication.personalStatusAsync ? publication.personalStatusAsync(...args) : unavailable(),
    personalPending: (...args) =>
      publication.personalPending ? publication.personalPending(...args) : unavailable(),
    sharedStatus: (...args) =>
      publication.sharedStatus ? publication.sharedStatus(...args) : unavailable(),
    latestShared: (...args) =>
      publication.latestShared ? publication.latestShared(...args) : unavailable(),
    latestPublishedShared: (...args) =>
      publication.latestPublishedShared
        ? publication.latestPublishedShared(...args)
        : unavailable(),
  };
}
export async function installPublicationRpcFixture(
  context: GatewayRequestContext,
  publication: Partial<NonNullable<RepositoryServices["publication"]>>,
) {
  const { createGitHubOAuthLifecycle } =
    await import("../../extensions/github-repositories/oauth-lifecycle-api.js");
  const { createTestGatewayScheduler } = await import("../test-utils/gateway-scheduler-clock.js");
  const scheduler = createTestGatewayScheduler();
  const serviceScheduler = createTestPluginServiceScheduler(scheduler);
  const oauth = createGitHubOAuthLifecycle({
    scheduler: serviceScheduler,
    getConfig: context.getRuntimeConfig,
    warn: () => {},
  });
  const stop = installGitHubAccountFixture(context, oauth, publication);
  onTestFinished(async () => {
    stop();
    await oauth.stop();
    await serviceScheduler.stop();
    await scheduler.stop();
  });
}

export function installGitHubAccountRpcFixture(config: OpenClawConfig) {
  const fixture = createPluginRegistryFixture(config);
  registerTestPlugin({
    ...fixture,
    record: createPluginRecord({
      id: repositoryManifest.id,
      name: repositoryManifest.name,
      contracts: repositoryManifest.contracts,
      repositorySources: repositoryManifest.repositorySources,
      dashboard: repositoryManifest.dashboard,
    }),
    register: repositoryPlugin.register,
  });
  setActivePluginRegistry(fixture.registry.registry);
  onTestFinished(resetPluginRuntimeStateForTest);
  return fixture.registry.registry;
}

/** Minimal Gateway fixtures skip sidecars; start only the real OAuth service for their host. */
export async function startMinimalGatewayGitHubAccountFixture(
  context: GatewayRequestContext | undefined,
) {
  if (!context) {
    throw new Error("expected the Gateway's request context");
  }
  await installPublicationRpcFixture(context, {});
  const personal = readRepositoryServices(context)?.oauth.personal;
  if (!personal) {
    throw new Error("expected the Gateway's personal GitHub service");
  }
  return personal;
}

export async function callGitHubAccountFixtureRpc(
  context: GatewayRequestContext,
  client: GatewayClient,
  method: string,
  params: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: `rpc-${method}`, method, params },
    client,
    context,
    respond,
    isWebchatConnect: () => false,
  });
  return respond;
}

/** Start the registered service for request tests; native admission remains the real owner. */
export async function startTestRepositorySessionPresentation(
  context: GatewayRequestContext,
  scheduler: GatewayScheduler,
  client?: GatewayClient,
  options: { resetRuntimeOnFinish?: boolean; cleanupOnFinish?: boolean } = {},
) {
  const fixture = createPluginRegistryFixture(context.getRuntimeConfig());
  registerTestPlugin({
    ...fixture,
    record: createPluginRecord({
      id: repositoryManifest.id,
      name: repositoryManifest.name,
      repositorySources: repositoryManifest.repositorySources,
      contracts: repositoryManifest.contracts,
      dashboard: repositoryManifest.dashboard,
    }),
    register: repositoryPlugin.register,
  });
  setActivePluginRegistry(fixture.registry.registry);
  let services: Awaited<ReturnType<typeof startPluginServices>> | undefined = undefined;
  if (options.cleanupOnFinish !== false) {
    onTestFinished(async () => {
      try {
        await services?.stop({ strict: true });
      } finally {
        if (options.resetRuntimeOnFinish !== false) {
          resetPluginRuntimeStateForTest();
        }
      }
    });
  }
  context.resolveGatewayContext ??= () => context;
  context.repositorySources ??= createRepositorySources(
    scheduler.signal,
    fixture.registry.registry,
  );
  context.repositorySessions ??= createRepositorySessionReadHost({
    signal: scheduler.signal,
    getRuntimeConfig: context.getRuntimeConfig,
    getSessionRowProjection: () => getSessionRowProjection(context),
    getClient: (connId) => (client?.connId === connId ? client : undefined),
    resolveGatewayContext: context.resolveGatewayContext,
    broadcastToConnIds: vi.fn(),
  });
  services = await withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () =>
    startPluginServices({
      scheduler,
      registry: fixture.registry.registry,
      config: context.getRuntimeConfig(),
    }),
  );
  return services;
}

const registeredPublicationProviderCleanup = new Set<() => Promise<void>>();

/** Stop services before the publication harness clears config and the global registry retires. */
export async function stopTestRegisteredPublicationProviders() {
  for (const close of [...registeredPublicationProviderCleanup].toReversed()) {
    await close();
  }
}

/** The real registered service and SDK installation bridge, with isolated native transaction custody. */
export async function startTestRegisteredPublicationProvider() {
  const { makeContextParams } = await import("./server-request-context.test-support.js");
  const { createGatewayRequestContext } = await import("./server-request-context.js");
  const { createWorkspacePublicationHost } = await import("./workspace-publication-provider.js");
  const { createWorkerSessionPlacementStore } =
    await import("./worker-environments/placement-store.js");
  const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
  const { loadWorkerPlacementSessionRuntimeModule } =
    await import("./server-worker-placement-startup.js");
  const { currentGitHubPublicationConfig } =
    await import("../../extensions/github-repositories/publication-availability-api.js");
  const params = makeContextParams();
  const scheduler = params.runtime.scheduler;
  const host = createWorkspacePublicationHost({
    placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
    scheduler,
    getCommittedRuntimeConfig: currentGitHubPublicationConfig,
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    managedByPlacement: true,
    warn() {},
  });
  params.runtime.workspacePublicationHost = host;
  const context = createGatewayRequestContext(params);
  context.getRuntimeConfig = currentGitHubPublicationConfig;
  context.getCommittedRuntimeConfig = currentGitHubPublicationConfig;
  context.resolveGatewayContext = () => context;
  params.runtime.runtimeState.repositorySessions = createRepositorySessionReadHost({
    signal: scheduler.signal,
    getRuntimeConfig: currentGitHubPublicationConfig,
    getSessionRowProjection: () => undefined,
    getClient: () => undefined,
    resolveGatewayContext: () => context,
    broadcastToConnIds() {},
  });
  let services: Awaited<ReturnType<typeof startTestRepositorySessionPresentation>> | undefined =
    undefined;
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    await services?.stop({ strict: true });
  };
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    registeredPublicationProviderCleanup.delete(close);
    try {
      await stop();
      await host.close();
      await scheduler.stop();
    } finally {
      resetPluginRuntimeStateForTest();
    }
  };
  registeredPublicationProviderCleanup.add(close);
  onTestFinished(close);
  services = await startTestRepositorySessionPresentation(context, scheduler, undefined, {
    cleanupOnFinish: false,
  });
  const api = readRepositoryServices(context)?.publication;
  if (!api) {
    throw new Error("The registered plugin did not install its publication provider.");
  }
  return { api, stop };
}

export async function createTestRepositorySessionPresentation(
  scheduler: GatewayScheduler,
  client: GatewayClient & { connId: string },
  replace: RepositorySessionPresentation["replace"],
  context: GatewayRequestContext = createContext(),
) {
  context.getClientConnIds = (filter) =>
    new Set(!client.invalidated && (!filter || filter(client)) ? [client.connId] : []);
  const host = createRepositorySessionReadHost({
    signal: scheduler.signal,
    getRuntimeConfig: context.getRuntimeConfig,
    getSessionRowProjection: () => getSessionRowProjection(context),
    getClient: (connId) => (client.connId === connId && !client.invalidated ? client : undefined),
    resolveGatewayContext: () => context,
    broadcastToConnIds: vi.fn(),
  });
  context.repositorySessions = host;
  const serviceScheduler = createTestPluginServiceScheduler(scheduler);
  const { startGitHubSessionPresentation } =
    await import("../../extensions/github-repositories/session-presentation-service-api.js");
  const service = startGitHubSessionPresentation({
    scheduler: serviceScheduler,
    getConfig: context.getRuntimeConfig,
    reads: host.bindService(scheduler.signal, () => scheduler.signal.throwIfAborted()),
  });
  service.presentation.replace = replace;
  return {
    context,
    stop: async () => {
      await service.stop();
      await serviceScheduler.stop();
    },
  };
}
