import type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { resolveApiKeyForProfile } from "../agents/auth-profiles/oauth.js";
import { loadConfig } from "../config/io.js";

/**
 * Central registry of all secrets available to the proxy.
 * This is loaded on the HOST and used by the proxy to inject secrets
 * into placeholder values before they reach external APIs.
 */
export type SecretRegistry = {
  /** OAuth credentials indexed by profile ID (with refresh capability). */
  oauthProfiles: Map<string, OAuthCredential>;

  /** Static API keys indexed by profile ID. */
  apiKeys: Map<string, string>;

  /** Static tokens indexed by profile ID. */
  tokens: Map<string, string>;

  /** Channel secrets from openclaw.yaml. */
  channelSecrets: {
    discord?: { token?: string };
    telegram?: { botToken?: string; webhookSecret?: string };
    slack?: { botToken?: string; appToken?: string; userToken?: string; signingSecret?: string };
    feishu?: { appId?: string; appSecret?: string };
    googlechat?: { serviceAccount?: string | object };
  };

  /** Gateway auth secrets. */
  gatewaySecrets: {
    authToken?: string;
    authPassword?: string;
    remoteToken?: string;
    remotePassword?: string;
    talkApiKey?: string;
  };

  /** Tool secrets from openclaw.yaml (web search/fetch API keys). */
  toolSecrets: {
    web?: {
      search?: { apiKey?: string; perplexity?: { apiKey?: string } };
      fetch?: { firecrawl?: { apiKey?: string } };
    };
    memory?: { remote?: { apiKey?: string } };
  };

  /** Environment variables from config. */
  envVars: Record<string, string>;

  /** Raw auth profile store (for OAuth refresh). */
  authStore: AuthProfileStore;

  /** Agent directory for auth profiles. */
  agentDir?: string;
};

/**
 * Load all auth profiles from auth-profiles.json.
 */
function loadAuthProfiles(agentDir?: string): {
  oauthProfiles: Map<string, OAuthCredential>;
  apiKeys: Map<string, string>;
  tokens: Map<string, string>;
  authStore: AuthProfileStore;
} {
  const store = ensureAuthProfileStore(agentDir);

  const oauthProfiles = new Map<string, OAuthCredential>();
  const apiKeys = new Map<string, string>();
  const tokens = new Map<string, string>();

  for (const [profileId, credential] of Object.entries(store.profiles)) {
    if (credential.type === "oauth") {
      oauthProfiles.set(profileId, credential);
    } else if (credential.type === "api_key" && credential.key) {
      apiKeys.set(profileId, credential.key);
    } else if (credential.type === "token" && credential.token) {
      tokens.set(profileId, credential.token);
    }
  }

  return { oauthProfiles, apiKeys, tokens, authStore: store };
}

/**
 * Extract secrets from openclaw.yaml config.
 */
function loadConfigSecrets(
  config: OpenClawConfig,
): Pick<SecretRegistry, "channelSecrets" | "gatewaySecrets" | "toolSecrets" | "envVars"> {
  const channelSecrets: SecretRegistry["channelSecrets"] = {};
  const gatewaySecrets: SecretRegistry["gatewaySecrets"] = {};
  const envVars: Record<string, string> = {};

  // Extract channel secrets
  if (config.channels?.discord?.token) {
    channelSecrets.discord = { token: config.channels.discord.token };
  }

  if (config.channels?.telegram) {
    channelSecrets.telegram = {
      botToken: config.channels.telegram.botToken,
      webhookSecret: config.channels.telegram.webhookSecret,
    };
  }

  if (config.channels?.slack) {
    channelSecrets.slack = {
      botToken: config.channels.slack.botToken,
      appToken: config.channels.slack.appToken,
      userToken: config.channels.slack.userToken,
      signingSecret: config.channels.slack.signingSecret,
    };
  }

  const feishu = config.channels?.feishu;
  if (feishu) {
    channelSecrets.feishu = {
      appId: feishu.appId,
      appSecret: feishu.appSecret,
    };
  }

  if (config.channels?.googlechat?.serviceAccount) {
    channelSecrets.googlechat = {
      serviceAccount: config.channels.googlechat.serviceAccount,
    };
  }

  // Extract gateway secrets
  if (config.gateway?.auth) {
    gatewaySecrets.authToken = config.gateway.auth.token;
    gatewaySecrets.authPassword = config.gateway.auth.password;
  }

  if (config.gateway?.remote) {
    gatewaySecrets.remoteToken = config.gateway.remote.token;
    gatewaySecrets.remotePassword = config.gateway.remote.password;
  }

  if (config.talk?.apiKey) {
    gatewaySecrets.talkApiKey = config.talk.apiKey;
  }

  // Extract env vars
  if (config.env?.vars) {
    Object.assign(envVars, config.env.vars);
  }

  // Extract tool secrets
  const toolSecrets: SecretRegistry["toolSecrets"] = {};
  if (config.tools?.web?.search?.apiKey) {
    toolSecrets.web = toolSecrets.web || {};
    toolSecrets.web.search = toolSecrets.web.search || {};
    toolSecrets.web.search.apiKey = config.tools.web.search.apiKey;
  }
  if (config.tools?.web?.search?.perplexity?.apiKey) {
    toolSecrets.web = toolSecrets.web || {};
    toolSecrets.web.search = toolSecrets.web.search || {};
    toolSecrets.web.search.perplexity = { apiKey: config.tools.web.search.perplexity.apiKey };
  }
  if (config.tools?.web?.fetch?.firecrawl?.apiKey) {
    toolSecrets.web = toolSecrets.web || {};
    toolSecrets.web.fetch = { firecrawl: { apiKey: config.tools.web.fetch.firecrawl.apiKey } };
  }
  const memoryConfig = (config as Record<string, unknown>).tools as
    | Record<string, unknown>
    | undefined;
  const memory = memoryConfig?.memory as Record<string, unknown> | undefined;
  const memoryRemote = memory?.remote as Record<string, unknown> | undefined;
  if (memoryRemote?.apiKey && typeof memoryRemote.apiKey === "string") {
    toolSecrets.memory = { remote: { apiKey: memoryRemote.apiKey } };
  }

  return { channelSecrets, gatewaySecrets, toolSecrets, envVars };
}

/**
 * Create a complete secrets registry from the host filesystem.
 * This should only be called on the HOST, never inside the container.
 */
export async function createSecretsRegistry(agentDir?: string): Promise<SecretRegistry> {
  // Load auth profiles
  const { oauthProfiles, apiKeys, tokens, authStore } = loadAuthProfiles(agentDir);

  // SECURITY: loadConfig() must read the REAL host config, never the sanitized
  // mount copy.  If OPENCLAW_SECURE_MODE is set but PROXY_URL is also present,
  // we are inside the container and must not run the registry from there.
  if (process.env.PROXY_URL) {
    throw new Error(
      "createSecretsRegistry must run on the HOST, not inside the container (PROXY_URL is set)",
    );
  }

  // Load config secrets
  const config = loadConfig();
  const { channelSecrets, gatewaySecrets, toolSecrets, envVars } = loadConfigSecrets(config);

  return {
    oauthProfiles,
    apiKeys,
    tokens,
    channelSecrets,
    gatewaySecrets,
    toolSecrets,
    envVars,
    authStore,
    agentDir,
  };
}

/**
 * Resolve an OAuth token for a profile, refreshing if needed.
 * Returns the raw access token for use in Authorization headers.
 */
export async function resolveOAuthToken(
  registry: SecretRegistry,
  profileId: string,
): Promise<string | null> {
  // Read from authStore.profiles (authoritative, live source) instead of the
  // startup-snapshotted oauthProfiles map so newly added/refreshed profiles work.
  const cred = registry.authStore.profiles[profileId];
  if (!cred || cred.type !== "oauth") {
    return null;
  }

  // Always call resolveApiKeyForProfile - it handles refresh internally
  const result = await resolveApiKeyForProfile({
    store: registry.authStore,
    profileId,
    agentDir: registry.agentDir,
  });

  if (!result?.apiKey) {
    return null;
  }

  // Derive provider from the authoritative authStore (not the cached oauthProfiles Map)
  // so provider-specific parsing tracks current state after refresh/reload.
  const currentCred = registry.authStore.profiles[profileId];
  const provider = currentCred?.type === "oauth" ? currentCred.provider : cred.provider;

  // For google-gemini-cli, the apiKey is JSON - extract the token
  if (provider === "google-gemini-cli" || provider === "google-antigravity") {
    try {
      const parsed = JSON.parse(result.apiKey);

      return parsed.token ?? null;
    } catch {
      // If not JSON, return as-is

      return result.apiKey;
    }
  }

  return result.apiKey;
}
