import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import type { OpenClawPluginDefinition } from "../plugins/plugin-definition.types.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { getGatewayServiceLifetime } from "../plugins/runtime/gateway-service-owner.js";
import { startPluginServices } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../test-utils/bundled-plugin-public-surface.js";
import { createRepositorySessionReadHost } from "./control-ui-session-pr-runtime.js";
import type { LegacyGitHubOAuthService } from "./github-oauth-lifecycle-host.types.js";
import type {
  RepositoryPublicationHostBinding,
  RepositoryPublicationApi,
  RepositoryPublicationProvider,
} from "./repository-publication-contract.js";
import type { RepositorySessionPresentation } from "./repository-session-read.types.js";
import { createRepositorySources } from "./repository-sources.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  bindWorkspacePublicationHost,
  readWorkspacePublicationHost,
} from "./workspace-publication-binding.js";

type RepositoryServices = {
  oauth: LegacyGitHubOAuthService;
  publication?: RepositoryPublicationApi;
};
const { installRepositoryServices, readRepositoryServices } = await loadBundledPluginFacade<{
  installRepositoryServices(
    owner: AbortSignal,
    services: RepositoryServices,
    signal: AbortSignal,
  ): () => void;
  readRepositoryServices(context: GatewayRequestContext): RepositoryServices | undefined;
}>({ pluginId: "github-repositories", artifactBasename: "account-runtime-api.ts" });
const { default: repositoryPlugin } = await loadBundledPluginFacade<{
  default: OpenClawPluginDefinition;
}>({
  pluginId: "github-repositories",
  artifactBasename: "index.ts",
});
const manifest = loadPluginManifest(
  path.dirname(
    resolveBundledPluginPublicModulePath({
      pluginId: "github-repositories",
      artifactBasename: "index.ts",
    }),
  ),
  false,
);
if (!manifest.ok) {
  throw new Error(manifest.error);
}
const repositoryManifest = manifest.manifest;
const registerRepositoryPlugin = expectDefined(
  repositoryPlugin.register,
  "GitHub plugin registration",
);

/** RPC admission fixtures inject one coordinator; provider bootstrap has its own real service proof. */
export async function installGitHubAccountFixture(
  context: GatewayRequestContext,
  oauth: RepositoryServices["oauth"],
  publication?: Partial<NonNullable<RepositoryServices["publication"]>>,
) {
  context.resolveGatewayContext ??= () => context;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, getGatewayServiceLifetime(context)]);
  let stopServices: (() => void) | undefined = undefined;
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    lifetime.abort();
    stopServices?.();
  };
  onTestFinished(stop);
  let api: RepositoryServices["publication"];
  if (publication) {
    const { createGitHubPublicationProvider } = await loadBundledPluginFacade<{
      createGitHubPublicationProvider(owner: {
        signal: AbortSignal;
        assertCurrent: () => void;
        getConfig: () => OpenClawConfig;
        refreshIdentity: (agentId: string) => Promise<void>;
        refreshPersonal: (profileId: string) => Promise<void>;
      }): RepositoryPublicationProvider;
    }>({ pluginId: "github-repositories", artifactBasename: "runtime-api.ts" });
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (readWorkspacePublicationHost(context) !== binding) {
        throw new Error("The publication fixture owner changed");
      }
    };
    const provider = createGitHubPublicationProvider({
      signal,
      assertCurrent,
      getConfig: context.getRuntimeConfig,
      refreshIdentity: (agentId) => oauth.refreshEffectiveIdentity(agentId),
      refreshPersonal: (profileId) => oauth.personal.refresh(profileId),
    });
    const selectedApi = createBoundPublicationFixtureApi(
      publication,
      provider,
      assertCurrent,
      oauth,
    );
    // This fixture is the host caller, not a second publication startup/recovery runtime.
    const binding: RepositoryPublicationHostBinding = {
      readApi() {
        if (signal.aborted) {
          return undefined;
        }
        assertCurrent();
        return selectedApi;
      },
      captureProviderAuthority(pluginId) {
        if (signal.aborted || pluginId !== provider.id) {
          return undefined;
        }
        assertCurrent();
        return assertCurrent;
      },
      async install() {
        throw new Error("Synthetic RPC fixtures cannot install a second publication owner");
      },
    };
    bindWorkspacePublicationHost(context.resolveGatewayContext() ?? context, binding);
    api = selectedApi;
  }
  stopServices = installRepositoryServices(
    getGatewayServiceLifetime(context),
    { oauth, ...(api ? { publication: api } : {}) },
    signal,
  );
  return stop;
}
function createBoundPublicationFixtureApi(
  publication: Partial<RepositoryPublicationApi>,
  provider: RepositoryPublicationProvider,
  assertCurrent: () => void,
  oauth?: LegacyGitHubOAuthService,
): RepositoryPublicationApi {
  const unavailable = (): never => {
    throw new Error("Unexpected publication operation in authorization fixture");
  };
  return {
    ...publicationFixtureApi(publication, assertCurrent),
    supportsOrigin(originUrl) {
      assertCurrent();
      return publication.supportsOrigin?.(originUrl) ?? provider.supportsOrigin(originUrl);
    },
    async performPullRequestAction(input) {
      assertCurrent();
      const result = await (publication.performPullRequestAction?.(input) ?? unavailable());
      assertCurrent();
      return result;
    },
    async inspectPullRequest(input) {
      assertCurrent();
      const result = await (publication.inspectPullRequest?.(input) ?? unavailable());
      assertCurrent();
      return result;
    },
    async readOptionsIdentity(input) {
      assertCurrent();
      const result = await (publication.readOptionsIdentity?.(input) ??
        provider.readOptionsIdentity(input));
      assertCurrent();
      input.assertCurrent();
      return result;
    },
    async preparePersonalAccountStatus(action) {
      assertCurrent();
      if (publication.preparePersonalAccountStatus) {
        const prepared = await publication.preparePersonalAccountStatus(action);
        assertCurrent();
        return {
          status: prepared.status,
          assertCurrent() {
            assertCurrent();
            prepared.assertCurrent();
          },
        };
      }
      if (!oauth) {
        const prepared = await provider.preparePersonalAccountStatus(action);
        assertCurrent();
        return {
          status: prepared.status,
          assertCurrent() {
            assertCurrent();
            prepared.assertCurrent();
          },
        };
      }
      const status = await oauth.personal.status(action);
      assertCurrent();
      return {
        status,
        assertCurrent() {
          assertCurrent();
          oauth.personal.revalidateStatus(action, status);
        },
      };
    },
    async isPublicationSuperseded(snapshot, readPublished) {
      assertCurrent();
      const result = await (publication.isPublicationSuperseded?.(snapshot, readPublished) ??
        provider.isPublicationSuperseded(snapshot, readPublished));
      assertCurrent();
      return result;
    },
  };
}

/** Keep synthetic receipt I/O observable through late-installed spies at its actual owner. */
export function publicationFixtureApi(
  publication: Partial<NonNullable<RepositoryServices["publication"]>>,
  assertCurrent: () => void,
): Omit<
  NonNullable<RepositoryServices["publication"]>,
  | "supportsOrigin"
  | "performPullRequestAction"
  | "inspectPullRequest"
  | "readOptionsIdentity"
  | "preparePersonalAccountStatus"
  | "isPublicationSuperseded"
> {
  const unavailable = (): never => {
    throw new Error("Unexpected publication operation in authorization fixture");
  };
  return {
    preparePullRequest: (...args) => {
      assertCurrent();
      return publication.preparePullRequest
        ? publication.preparePullRequest(...args)
        : unavailable();
    },
    refreshBase: (...args) => {
      assertCurrent();
      return publication.refreshBase ? publication.refreshBase(...args) : unavailable();
    },
    requestForSessionV2: (...args) => {
      assertCurrent();
      return publication.requestForSessionV2
        ? publication.requestForSessionV2(...args)
        : unavailable();
    },
    requestPersonalForSessionV2: (...args) => {
      assertCurrent();
      return publication.requestPersonalForSessionV2
        ? publication.requestPersonalForSessionV2(...args)
        : unavailable();
    },
    confirmPersonalV2: (...args) => {
      assertCurrent();
      return publication.confirmPersonalV2 ? publication.confirmPersonalV2(...args) : unavailable();
    },
    preparePersonalStatus: (...args) => {
      assertCurrent();
      return publication.preparePersonalStatus
        ? publication.preparePersonalStatus(...args)
        : unavailable();
    },
    personalStatusAsync: (...args) => {
      assertCurrent();
      return publication.personalStatusAsync
        ? publication.personalStatusAsync(...args)
        : unavailable();
    },
    personalPending: (...args) => {
      assertCurrent();
      return publication.personalPending ? publication.personalPending(...args) : unavailable();
    },
    sharedStatus: (...args) => {
      assertCurrent();
      return publication.sharedStatus ? publication.sharedStatus(...args) : unavailable();
    },
    latestShared: (...args) => {
      assertCurrent();
      return publication.latestShared ? publication.latestShared(...args) : unavailable();
    },
    latestPublishedShared: (...args) => {
      assertCurrent();
      return publication.latestPublishedShared
        ? publication.latestPublishedShared(...args)
        : unavailable();
    },
  };
}
export async function installPublicationRpcFixture(
  context: GatewayRequestContext,
  publication: Partial<RepositoryPublicationApi>,
) {
  const { createTestGatewayScheduler } = await import("../test-utils/gateway-scheduler-clock.js");
  const scheduler = createTestGatewayScheduler();
  context.resolveGatewayContext ??= () => context;
  let provider: RepositoryPublicationProvider | undefined;
  let api: RepositoryPublicationApi | undefined;
  let current: { signal: AbortSignal; assertCurrent: () => void } | undefined;
  const binding: RepositoryPublicationHostBinding = {
    readApi() {
      if (!current || current.signal.aborted) {
        return undefined;
      }
      current.assertCurrent();
      return api;
    },
    captureProviderAuthority(pluginId) {
      if (!provider || provider.id !== pluginId || !current || current.signal.aborted) {
        return undefined;
      }
      current.assertCurrent();
      return current.assertCurrent;
    },
    async install(next, ownerSignal) {
      const signal = AbortSignal.any([
        scheduler.signal,
        ownerSignal,
        getGatewayServiceLifetime(context),
      ]);
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (provider !== next || readWorkspacePublicationHost(context) !== binding) {
          throw new Error("The publication fixture owner changed");
        }
        next.assertCurrent();
      };
      provider = next;
      current = { signal, assertCurrent };
      assertCurrent();
      const selectedApi = createBoundPublicationFixtureApi(publication, next, assertCurrent);
      api = selectedApi;
      return {
        api: selectedApi,
        uninstall() {
          if (provider === next) {
            provider = undefined;
            api = undefined;
            current = undefined;
          }
        },
      };
    },
  };
  bindWorkspacePublicationHost(context.resolveGatewayContext() ?? context, binding);
  let services: Awaited<ReturnType<typeof startTestRepositorySessionPresentation>> | undefined =
    undefined;
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    registeredPublicationProviderCleanup.delete(close);
    try {
      await services?.stop({ strict: true });
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
  return {
    stop: close,
    provider: expectDefined(provider, "The registered publication provider"),
    oauth: expectDefined(readRepositoryServices(context), "The registered GitHub account service")
      .oauth,
  };
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
    register: registerRepositoryPlugin,
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
    register: registerRepositoryPlugin,
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
  const services = await startTestRepositorySessionPresentation(context, scheduler, client, {
    cleanupOnFinish: false,
  });
  const presentation = host.presentation;
  if (!presentation) {
    throw new Error("The registered plugin did not install its session presentation.");
  }
  presentation.replace = replace;
  return { context, stop: () => services.stop({ strict: true }) };
}
