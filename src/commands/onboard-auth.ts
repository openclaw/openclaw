import type { OAuthCredentials, OAuthProvider } from "@mariozechner/pi-ai";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import type { ClawdbotConfig } from "../config/config.js";

export async function writeOAuthCredentials(
  provider: OAuthProvider,
  creds: OAuthCredentials,
): Promise<void> {
  upsertAuthProfile({
    profileId: `${provider}:default`,
    credential: {
      type: "oauth",
      provider,
      ...creds,
    },
  });
}

export async function setAnthropicApiKey(key: string) {
  upsertAuthProfile({
    profileId: "anthropic:default",
    credential: {
      type: "api_key",
      provider: "anthropic",
      key,
    },
  });
}

export function applyAuthProfileConfig(
  cfg: ClawdbotConfig,
  params: {
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth";
    email?: string;
  },
): ClawdbotConfig {
  const profiles = {
    ...cfg.auth?.profiles,
    [params.profileId]: {
      provider: params.provider,
      mode: params.mode,
      ...(params.email ? { email: params.email } : {}),
    },
  };
  const order = { ...cfg.auth?.order };
  const list = order[params.provider] ? [...order[params.provider]] : [];
  if (!list.includes(params.profileId)) list.push(params.profileId);
  order[params.provider] = list;
  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      profiles,
      order,
    },
  };
}

export function applyMinimaxConfig(cfg: ClawdbotConfig): ClawdbotConfig {
  const models = { ...cfg.agent?.models };
  models["anthropic/claude-opus-4-5"] = {
    ...models["anthropic/claude-opus-4-5"],
    alias: models["anthropic/claude-opus-4-5"]?.alias ?? "Opus",
  };
  models["lmstudio/minimax-m2.1-gs32"] = {
    ...models["lmstudio/minimax-m2.1-gs32"],
    alias: models["lmstudio/minimax-m2.1-gs32"]?.alias ?? "Minimax",
  };

  const providers = { ...cfg.models?.providers };
  if (!providers.lmstudio) {
    providers.lmstudio = {
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "lmstudio",
      api: "openai-responses",
      models: [
        {
          id: "minimax-m2.1-gs32",
          name: "MiniMax M2.1 GS32",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 196608,
          maxTokens: 8192,
        },
      ],
    };
  }

  return {
    ...cfg,
    agent: {
      ...cfg.agent,
      model: {
        ...((cfg.agent?.model as { primary?: string; fallbacks?: string[] }) ??
          {}),
        primary: "lmstudio/minimax-m2.1-gs32",
      },
      models,
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}
