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
import { loadConfig } from "../config/config.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import type { UsageProviderId } from "./provider-usage.types.js";

export type ProviderAuth = {
  provider: UsageProviderId;
  token: string;
  accountId?: string;
};

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

function resolveZaiApiKey(): string | undefined {
  const envDirect =
    normalizeSecretInput(process.env.ZAI_API_KEY) || normalizeSecretInput(process.env.Z_AI_API_KEY);
  if (envDirect) {
    return envDirect;
  }

  const cfg = loadConfig();
  const key =
    resolveUsableCustomProviderApiKey({ cfg, provider: "zai" })?.apiKey ??
    resolveUsableCustomProviderApiKey({ cfg, provider: "z-ai" })?.apiKey;
  if (key) {
    return key;
  }

  const store = ensureAuthProfileStore();
  const apiProfile = [
    ...listProfilesForProvider(store, "zai"),
    ...listProfilesForProvider(store, "z-ai"),
  ].find((id) => store.profiles[id]?.type === "api_key");
  if (apiProfile) {
    const cred = store.profiles[apiProfile];
    if (cred?.type === "api_key" && normalizeSecretInput(cred.key)) {
      return normalizeSecretInput(cred.key);
    }
  }

  try {
    const authPath = path.join(
      resolveRequiredHomeDir(process.env, os.homedir),
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

function resolveMinimaxApiKey(): string | undefined {
  return resolveProviderApiKeyFromConfigAndStore({
    providerId: "minimax",
    envDirect: [process.env.MINIMAX_CODE_PLAN_KEY, process.env.MINIMAX_API_KEY],
  });
}

function resolveXiaomiApiKey(): string | undefined {
  return resolveProviderApiKeyFromConfigAndStore({
    providerId: "xiaomi",
    envDirect: [process.env.XIAOMI_API_KEY],
  });
}

/**
 * Resolve Ollama session cookie.
 *
 * Ollama doesn't have a public API for usage. We need the browser session cookie
 * to fetch usage data from ollama.com/settings.
 *
 * Priority:
 * 1. OLLAMA_COOKIE environment variable (explicit override)
 * 2. ~/.openclaw/ollama-usage-cookie file (set via `openclaw models auth ollama-cookie`)
 *
 * SECURITY: We use a separate file from auth profiles because:
 * - Auth profiles are also used for Ollama API authentication
 * - Using an API token as a cookie would leak secrets to ollama.com
 * - This file is specifically for browser session cookies only
 *
 * The cookie string should be in format: "name1=value1; name2=value2"
 * Common session cookie names: __Secure-session, session, next-auth.session-token
 */
async function resolveOllamaCookie(): Promise<string | undefined> {
  // Priority 1: Environment variable override
  const envCookie = normalizeSecretInput(process.env.OLLAMA_COOKIE);
  if (envCookie) {
    return envCookie;
  }

  // Priority 2: Cookie file (~/.openclaw/ollama-usage-cookie)
  // Uses resolveOllamaCookiePath() which honors OPENCLAW_HOME
  try {
    const cookiePath = resolveOllamaCookiePath();
    if (fs.existsSync(cookiePath)) {
      const cookie = fs.readFileSync(cookiePath, "utf-8").trim();
      return normalizeSecretInput(cookie) || undefined;
    }
  } catch {
    // Ignore errors reading the file
  }

  return undefined;
}
function resolveProviderApiKeyFromConfigAndStore(params: {
  providerId: UsageProviderId;
  envDirect: Array<string | undefined>;
}): string | undefined {
  const envDirect = params.envDirect.map(normalizeSecretInput).find(Boolean);
  if (envDirect) {
    return envDirect;
  }

  const cfg = loadConfig();
  const key = resolveUsableCustomProviderApiKey({
    cfg,
    provider: params.providerId,
  })?.apiKey;
  if (key) {
    return key;
  }

  const store = ensureAuthProfileStore();
  const cred = listProfilesForProvider(store, params.providerId)
    .map((id) => store.profiles[id])
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
  provider: UsageProviderId;
  agentDir?: string;
}): Promise<ProviderAuth | null> {
  const cfg = loadConfig();
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider: params.provider,
  });
  const deduped = dedupeProfileIds(order);

  for (const profileId of deduped) {
    const cred = store.profiles[profileId];
    if (!cred || (cred.type !== "oauth" && cred.type !== "token")) {
      continue;
    }
    try {
      const resolved = await resolveApiKeyForProfile({
        // Usage snapshots should work even if config profile metadata is stale.
        // (e.g. config says api_key but the store has a token profile.)
        cfg: undefined,
        store,
        profileId,
        agentDir: params.agentDir,
      });
      if (resolved) {
        let token = resolved.apiKey;
        if (params.provider === "google-gemini-cli") {
          const parsed = parseGoogleToken(resolved.apiKey);
          token = parsed?.token ?? resolved.apiKey;
        }
        return {
          provider: params.provider,
          token,
          accountId:
            cred.type === "oauth" && "accountId" in cred
              ? (cred as { accountId?: string }).accountId
              : undefined,
        };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function resolveOAuthProviders(agentDir?: string): UsageProviderId[] {
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const cfg = loadConfig();
  const providers = [
    "anthropic",
    "github-copilot",
    "google-gemini-cli",
    "openai-codex",
  ] satisfies UsageProviderId[];
  const isOAuthLikeCredential = (id: string) => {
    const cred = store.profiles[id];
    return cred?.type === "oauth" || cred?.type === "token";
  };
  return providers.filter((provider) => {
    const profiles = listProfilesForProvider(store, provider).filter(isOAuthLikeCredential);
    if (profiles.length > 0) {
      return true;
    }
    const normalized = normalizeProviderId(provider);
    const configuredProfiles = Object.entries(cfg.auth?.profiles ?? {})
      .filter(([, profile]) => normalizeProviderId(profile.provider) === normalized)
      .map(([id]) => id)
      .filter(isOAuthLikeCredential);
    return configuredProfiles.length > 0;
  });
}

export async function resolveProviderAuths(params: {
  providers: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
}): Promise<ProviderAuth[]> {
  if (params.auth) {
    return params.auth;
  }

  const oauthProviders = resolveOAuthProviders(params.agentDir);
  const auths: ProviderAuth[] = [];

  for (const provider of params.providers) {
    if (provider === "zai") {
      const apiKey = resolveZaiApiKey();
      if (apiKey) {
        auths.push({ provider, token: apiKey });
      }
      continue;
    }
    if (provider === "minimax") {
      const apiKey = resolveMinimaxApiKey();
      if (apiKey) {
        auths.push({ provider, token: apiKey });
      }
      continue;
    }
    if (provider === "xiaomi") {
      const apiKey = resolveXiaomiApiKey();
      if (apiKey) {
        auths.push({ provider, token: apiKey });
      }
      continue;
    }
    if (provider === "ollama") {
      const cookie = await resolveOllamaCookie();
      if (cookie) {
        auths.push({ provider, token: cookie });
      }
      continue;
    }

    if (!oauthProviders.includes(provider)) {
      continue;
    }
    const auth = await resolveOAuthToken({
      provider,
      agentDir: params.agentDir,
    });
    if (auth) {
      auths.push(auth);
    }
  }

  return auths;
}

/**
 * Path to the Ollama cookie file.
 */
export function resolveOllamaCookiePath(): string {
  return path.join(
    resolveRequiredHomeDir(process.env, os.homedir),
    ".openclaw",
    "ollama-usage-cookie",
  );
}

/**
 * Save the Ollama cookie to the dedicated file.
 */
export function saveOllamaCookie(cookie: string): void {
  const cookiePath = resolveOllamaCookiePath();
  const dir = path.dirname(cookiePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(cookiePath, cookie, "utf-8");
}

/**
 * Clear the saved Ollama cookie.
 */
export function clearOllamaCookie(): void {
  const cookiePath = resolveOllamaCookiePath();
  if (fs.existsSync(cookiePath)) {
    fs.unlinkSync(cookiePath);
  }
}
