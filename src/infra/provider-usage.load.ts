// Loads provider usage snapshots from built-in and plugin providers.
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

// Built-in fallback intentionally reports unsupported until a plugin supplies usage behavior.
async function fetchProviderUsageSnapshotFallback(params: {
  auth: ProviderAuth;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  void params.timeoutMs;
  void params.fetchFn;
  return {
    provider: params.auth.provider,
    displayName: providerUsageLabel(params.auth.provider) ?? params.auth.provider,
    windows: [],
    error: "Unsupported provider",
  };
}

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
};

async function fetchProviderUsageSnapshot(params: {
  auth: ProviderAuth;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
  workspaceDir?: string;
  timeoutMs: number;
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
      rateLimitTier: params.auth.rateLimitTier,
      email: params.auth.email,
      timeoutMs: params.timeoutMs,
      fetchFn: params.fetchFn,
    },
  });
  if (pluginSnapshot) {
    return {
      ...pluginSnapshot,
      ...(params.auth.email && !pluginSnapshot.accountEmail
        ? { accountEmail: params.auth.email }
        : {}),
      ...(params.auth.authProfileId ? { authProfileId: params.auth.authProfileId } : {}),
      ...(params.auth.authProfileOrder ? { authProfileOrder: params.auth.authProfileOrder } : {}),
      ...(params.auth.isPreferred !== undefined ? { isPreferred: params.auth.isPreferred } : {}),
      ...(params.auth.credentialExpiresAt !== undefined
        ? { credentialExpiresAt: params.auth.credentialExpiresAt }
        : {}),
      ...(params.auth.credentialStatus ? { credentialStatus: params.auth.credentialStatus } : {}),
      ...(params.auth.credentialRefreshable !== undefined
        ? { credentialRefreshable: params.auth.credentialRefreshable }
        : {}),
    };
  }
  return await fetchProviderUsageSnapshotFallback({
    auth: params.auth,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
  });
}

/** Loads usage snapshots from configured provider auth and plugin-backed usage hooks. */
export async function loadProviderUsageSummary(
  opts: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? PROVIDER_USAGE_TIMEOUT_MS;
  const config = opts.config ?? getRuntimeConfig();
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetch
    ? resolveFetch(opts.fetch)
    : (resolveProxyFetchFromEnv(env) ?? resolveFetch());
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }

  const descriptors: ProviderUsagePluginDescriptor[] = opts.providers
    ? opts.providers.map((provider) => ({
        provider,
        displayName: providerUsageLabel(provider) ?? provider,
      }))
    : opts.auth
      ? [...new Set(opts.auth.map((auth) => auth.provider))].map((provider) => ({
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
  const failureSnapshot = (
    provider: UsageProviderId,
    error: string,
    auth?: ProviderAuth,
  ): ProviderUsageSnapshot => ({
    provider,
    displayName: displayNames.get(provider) ?? providerUsageLabel(provider) ?? provider,
    windows: [],
    error,
    ...(auth?.email ? { accountEmail: auth.email } : {}),
    ...(auth?.authProfileId ? { authProfileId: auth.authProfileId } : {}),
    ...(auth?.authProfileOrder ? { authProfileOrder: auth.authProfileOrder } : {}),
    ...(auth?.isPreferred !== undefined ? { isPreferred: auth.isPreferred } : {}),
    ...(auth?.credentialExpiresAt !== undefined
      ? { credentialExpiresAt: auth.credentialExpiresAt }
      : {}),
    ...(auth?.credentialStatus ? { credentialStatus: auth.credentialStatus } : {}),
    ...(auth?.credentialRefreshable !== undefined
      ? { credentialRefreshable: auth.credentialRefreshable }
      : {}),
  });
  let authStore = opts.authStore;
  const getAuthStore = () =>
    (authStore ??= ensureAuthProfileStore(opts.agentDir, { allowKeychainPrompt: false }));
  const tasks = descriptors.map(async ({ provider }) => {
    let auths: ProviderAuth[];
    try {
      let authError: unknown;
      auths = opts.auth
        ? opts.auth.filter((candidate) => candidate.provider === provider)
        : await resolveProviderAuths({
            providers: [provider],
            agentDir: opts.agentDir,
            config,
            env,
            getStore: getAuthStore,
            store: opts.authStore,
            onError: (_provider, error) => {
              authError = error;
            },
          });
      if (authError) {
        const message = formatErrorMessage(authError);
        return [failureSnapshot(provider, message.trim() || "Auth failed")];
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      return [failureSnapshot(provider, message.trim() || "Auth failed")];
    }

    return await Promise.all(
      auths.map((auth) =>
        // Each saved account owns its timeout and failure so one bad profile
        // cannot hide successful siblings.
        raceUsageTimeout(
          trackAsyncWork(async () => {
            if (auth.authError) {
              return failureSnapshot(provider, auth.authError, auth);
            }
            return await fetchProviderUsageSnapshot({
              auth,
              config,
              env,
              agentDir: opts.agentDir,
              workspaceDir: opts.workspaceDir,
              timeoutMs,
              fetchFn,
            });
          }),
          timeoutMs,
          failureSnapshot(provider, "Timeout", auth),
        ).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return failureSnapshot(provider, message.trim() || "Fetch failed", auth);
        }),
      ),
    );
  });

  const snapshots = (await Promise.all(tasks))
    .flat()
    .toSorted(
      (left, right) =>
        (providerOrder.get(left.provider) ?? Number.MAX_SAFE_INTEGER) -
        (providerOrder.get(right.provider) ?? Number.MAX_SAFE_INTEGER),
    );
  const providers = snapshots.filter((entry) => {
    if (entry.windows.length > 0) {
      return true;
    }
    if (entry.billing && entry.billing.length > 0) {
      return true;
    }
    if (entry.costHistory?.daily.length) {
      return true;
    }
    if (entry.summary?.trim()) {
      return true;
    }
    if (!entry.error) {
      return true;
    }
    return !ignoredErrors.has(entry.error);
  });

  return { updatedAt: now, providers };
}
