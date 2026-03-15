import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dedupeProfileIds,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../agents/auth-profiles.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { resolveUsableCustomProviderApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { resolveProviderUsageAuthWithPlugin } from "../plugins/provider-runtime.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import type { UsageProviderId } from "./provider-usage.types.js";

export type ProviderAuth = {
  provider: UsageProviderId;
  token: string;
  accountId?: string;
};

type AuthStore = ReturnType<typeof ensureAuthProfileStore>;

type UsageAuthState = {
  cfg: OpenClawConfig;
  store: AuthStore;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
};

const LEGACY_OAUTH_USAGE_PROVIDERS = new Set<UsageProviderId>([
  "anthropic",
  "github-copilot",
  "google-gemini-cli",
  "openai-codex",
]);

function parseGoogleToken(apiKey: string): { token: string } | null {
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown };
    if (parsed && typeof parsed.token === "string") {
      return { token: parsed.token };
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveLegacyZaiApiKey(state: UsageAuthState): string | undefined {
  try {
    const authPath = path.join(
      resolveRequiredHomeDir(state.env, os.homedir),
      ".pi",
      "agent",
      "auth.json",
    );
    if (!fs.existsSync(authPath)) {
      return undefined;
    }
    const data = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<
      string,
      { access?: string }
    >;
    return data["z-ai"]?.access || data.zai?.access;
  } catch {
    return undefined;
  }
}

function resolveProviderApiKeyFromConfigAndStore(params: {
  state: UsageAuthState;
  providerIds: string[];
  envDirect?: Array<string | undefined>;
}): string | undefined {
  const envDirect = params.envDirect?.map(normalizeSecretInput).find(Boolean);
  if (envDirect) {
    return envDirect;
  }

  for (const providerId of params.providerIds) {
    const key = resolveUsableCustomProviderApiKey({
      cfg: params.state.cfg,
      provider: providerId,
    })?.apiKey;
    if (key) {
      return key;
    }
  }

  const normalizedProviderIds = new Set(
    params.providerIds.map((providerId) => normalizeProviderId(providerId)).filter(Boolean),
  );
  const cred = [...normalizedProviderIds]
    .flatMap((providerId) => listProfilesForProvider(params.state.store, providerId))
    .map((id) => params.state.store.profiles[id])
    .find(
      (
        profile,
      ): profile is
        | { type: "api_key"; provider: string; key: string }
        | { type: "token"; provider: string; token: string } =>
        profile?.type === "api_key" || profile?.type === "token",
    );
  if (!cred) {
    return undefined;
  }
  if (cred.type === "api_key") {
    const key = normalizeSecretInput(cred.key);
    if (key && !isNonSecretApiKeyMarker(key)) {
      return key;
    }
    return undefined;
  }
  const token = normalizeSecretInput(cred.token);
  if (token && !isNonSecretApiKeyMarker(token)) {
    return token;
  }
  return undefined;
}

async function resolveOAuthToken(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): Promise<ProviderAuth | null> {
  const order = resolveAuthProfileOrder({
    cfg: params.state.cfg,
    store: params.state.store,
    provider: params.provider,
  });
  const deduped = dedupeProfileIds(order);

  for (const profileId of deduped) {
    const cred = params.state.store.profiles[profileId];
    if (!cred || (cred.type !== "oauth" && cred.type !== "token")) {
      continue;
    }
    try {
      const resolved = await resolveApiKeyForProfile({
        // Usage snapshots should work even if config profile metadata is stale.
        // (e.g. config says api_key but the store has a token profile.)
        cfg: undefined,
        store: params.state.store,
        profileId,
        agentDir: params.state.agentDir,
      });
      if (!resolved) {
        continue;
      }
      return {
        provider: params.provider,
        token: resolved.apiKey,
        accountId:
          cred.type === "oauth" && "accountId" in cred
            ? (cred as { accountId?: string }).accountId
            : undefined,
      };
    } catch {
      // ignore
    }
  }

  return null;
}

async function resolveProviderUsageAuthViaPlugin(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): Promise<ProviderAuth | null> {
  const resolved = await resolveProviderUsageAuthWithPlugin({
    provider: params.provider,
    config: params.state.cfg,
    env: params.state.env,
    context: {
      config: params.state.cfg,
      agentDir: params.state.agentDir,
      env: params.state.env,
      provider: params.provider,
      resolveApiKeyFromConfigAndStore: (options) =>
        resolveProviderApiKeyFromConfigAndStore({
          state: params.state,
          providerIds: options?.providerIds ?? [params.provider],
          envDirect: options?.envDirect,
        }),
      resolveOAuthToken: async () => {
        const auth = await resolveOAuthToken({
          state: params.state,
          provider: params.provider,
        });
        return auth
          ? {
              token: auth.token,
              ...(auth.accountId ? { accountId: auth.accountId } : {}),
            }
          : null;
      },
    },
  });
  if (!resolved?.token) {
    return null;
  }
  return {
    provider: params.provider,
    token: resolved.token,
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
  };
}

export async function resolveProviderAuths(params: {
  providers: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
}): Promise<ProviderAuth[]> {
  if (params.auth) {
    return params.auth;
  }

  const state: UsageAuthState = {
    cfg: loadConfig(),
    store: ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    }),
    env: process.env,
    agentDir: params.agentDir,
  };
  const auths: ProviderAuth[] = [];

  for (const provider of params.providers) {
    const pluginAuth = await resolveProviderUsageAuthViaPlugin({
      state,
      provider,
    });
    if (pluginAuth) {
      auths.push(pluginAuth);
      continue;
    }

    if (provider === "zai") {
      const apiKey =
        resolveProviderApiKeyFromConfigAndStore({
          state,
          providerIds: ["zai", "z-ai"],
          envDirect: [state.env.ZAI_API_KEY, state.env.Z_AI_API_KEY],
        }) ?? resolveLegacyZaiApiKey(state);
      if (apiKey) {
        auths.push({ provider, token: apiKey });
      }
      continue;
    }

    if (provider === "minimax") {
      const apiKey = resolveProviderApiKeyFromConfigAndStore({
        state,
        providerIds: ["minimax"],
        envDirect: [state.env.MINIMAX_CODE_PLAN_KEY, state.env.MINIMAX_API_KEY],
      });
      if (apiKey) {
        auths.push({ provider, token: apiKey });
      }
      continue;
    }

    if (provider === "xiaomi") {
      const apiKey = resolveProviderApiKeyFromConfigAndStore({
        state,
        providerIds: ["xiaomi"],
        envDirect: [state.env.XIAOMI_API_KEY],
      });
      if (apiKey) {
        auths.push({ provider, token: apiKey });
      }
      continue;
    }

    if (!LEGACY_OAUTH_USAGE_PROVIDERS.has(provider)) {
      continue;
    }

    const auth = await resolveOAuthToken({
      state,
      provider,
    });
    if (!auth) {
      continue;
    }
    if (provider === "google-gemini-cli") {
      const parsed = parseGoogleToken(auth.token);
      auths.push({
        ...auth,
        token: parsed?.token ?? auth.token,
      });
      continue;
    }
    auths.push(auth);
  }

  return auths;
}
