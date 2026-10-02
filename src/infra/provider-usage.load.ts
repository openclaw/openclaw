import { ensureAuthProfileStore, type AuthProfileStore } from "../agents/auth-profiles.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import {
  listProviderUsagePluginDescriptors,
  resolveProviderUsageSnapshotWithPlugin,
  type ProviderUsagePluginDescriptor,
} from "../plugins/provider-runtime.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { formatErrorMessage } from "./errors.js";
import { resolveFetch } from "./fetch.js";
import { resolveProxyFetchFromEnv } from "./net/proxy-fetch.js";
import { type ProviderAuth, resolveProviderAuths } from "./provider-usage.auth.js";
import {
  PROVIDER_USAGE_TIMEOUT_MS,
  ignoredErrors,
  providerUsageLabel,
  raceUsageTimeout,
} from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "./provider-usage.types.js";

type UsageSummaryOptions = {
  now?: number;
  timeoutMs?: number;
  providers?: UsageProviderId[];
  auth?: ProviderAuth[];
  authStore?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

async function fetchProviderUsageSnapshot(params: {
  auth: ProviderAuth;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
  workspaceDir?: string;
  timeoutMs: number;
  signal: AbortSignal;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  const pluginSnapshot = await resolveProviderUsageSnapshotWithPlugin({
    provider: params.auth.hookProvider ?? params.auth.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    context: {
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      env: params.env,
      provider: params.auth.provider,
      token: params.auth.token,
      accountId: params.auth.accountId,
      authProfileId: params.auth.authProfileId,
      subscriptionType: params.auth.subscriptionType,
      authFlow: params.auth.authFlow,
      rateLimitTier: params.auth.rateLimitTier,
      email: params.auth.email,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      fetchFn: params.fetchFn,
    },
  });
  return (
    pluginSnapshot ?? {
      provider: params.auth.provider,
      displayName: providerUsageLabel(params.auth.provider) ?? params.auth.provider,
      windows: [],
      error: "Unsupported provider",
    }
  );
}

/** Loads usage snapshots from configured provider auth and plugin-backed usage hooks. */
export async function loadProviderUsageSummary(
  opts: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? PROVIDER_USAGE_TIMEOUT_MS;
  const config = opts.config ?? getRuntimeConfig();
  const env = opts.env ?? process.env;
  const requestedProviders = opts.providers ?? opts.auth?.map(({ provider }) => provider);
  const descriptors: ProviderUsagePluginDescriptor[] = requestedProviders
    ? requestedProviders.map((provider) => ({
        provider,
        displayName: providerUsageLabel(provider) ?? provider,
      }))
    : listProviderUsagePluginDescriptors({
        config,
        workspaceDir: opts.workspaceDir,
        env,
      });
  const displayNames = new Map(
    descriptors.map((descriptor) => [descriptor.provider, descriptor.displayName]),
  );
  const providerOrder = new Map(descriptors.map(({ provider }, index) => [provider, index]));
  const failureSnapshot = (provider: UsageProviderId, error: string): ProviderUsageSnapshot => ({
    provider,
    displayName: displayNames.get(provider) ?? providerUsageLabel(provider) ?? provider,
    windows: [],
    error,
  });
  if (timeoutMs <= 0) {
    return {
      updatedAt: now,
      providers: descriptors.map(({ provider }) => failureSnapshot(provider, "Timeout")),
    };
  }
  const fetchFn = opts.fetch
    ? resolveFetch(opts.fetch)
    : (resolveProxyFetchFromEnv(env) ?? resolveFetch());
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }
  let authStore = opts.authStore;
  const getAuthStore = () =>
    (authStore ??= ensureAuthProfileStore(opts.agentDir, { allowKeychainPrompt: false }));
  const tasks = descriptors.map(({ provider }) => {
    return raceUsageTimeout(
      (timeoutSignal) =>
        trackAsyncWork(async () => {
          const signal = opts.signal
            ? AbortSignal.any([timeoutSignal, opts.signal])
            : timeoutSignal;
          signal.throwIfAborted();
          let authError: unknown;
          const auth =
            opts.auth?.find((candidate) => candidate.provider === provider) ??
            (
              await resolveProviderAuths({
                providers: [provider],
                agentDir: opts.agentDir,
                config,
                env,
                signal,
                getStore: getAuthStore,
                store: opts.authStore,
                onError: (_provider, error) => {
                  authError = error;
                },
              })
            )[0];
          signal.throwIfAborted();
          if (authError) {
            const message = formatErrorMessage(authError);
            return failureSnapshot(provider, message.trim() || "Auth failed");
          }
          if (!auth) {
            return undefined;
          }
          return await fetchProviderUsageSnapshot({
            auth,
            config,
            env,
            agentDir: opts.agentDir,
            workspaceDir: opts.workspaceDir,
            timeoutMs,
            signal,
            fetchFn: (input, init) => {
              signal.throwIfAborted();
              const callerSignal =
                init?.signal === undefined && input instanceof Request
                  ? input.signal
                  : init?.signal;
              return fetchFn(input, {
                ...init,
                signal: callerSignal ? AbortSignal.any([signal, callerSignal]) : signal,
              });
            },
          });
        }),
      timeoutMs,
      failureSnapshot(provider, "Timeout"),
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return failureSnapshot(provider, message.trim() || "Fetch failed");
    });
  });

  const snapshots = (await Promise.all(tasks))
    .filter((snapshot): snapshot is ProviderUsageSnapshot => snapshot !== undefined)
    .toSorted(
      (left, right) =>
        (providerOrder.get(left.provider) ?? Number.MAX_SAFE_INTEGER) -
        (providerOrder.get(right.provider) ?? Number.MAX_SAFE_INTEGER),
    );
  const providers = snapshots.filter(
    (entry) =>
      entry.windows.length > 0 ||
      (entry.billing?.length ?? 0) > 0 ||
      entry.costHistory?.daily.length ||
      entry.summary?.trim() ||
      !entry.error ||
      !ignoredErrors.has(entry.error),
  );

  return { updatedAt: now, providers };
}
