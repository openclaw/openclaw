import type { OAuthCredentials, OAuthProvider } from "@mariozechner/pi-ai";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import type { ClawdbotConfig } from "../config/config.js";

export async function writeOAuthCredentials(
  provider: OAuthProvider,
  creds: OAuthCredentials,
  agentDir?: string,
): Promise<void> {
  // Write to the multi-agent path so gateway finds credentials on startup
  upsertAuthProfile({
    profileId: `${provider}:${creds.email ?? "default"}`,
    credential: {
      type: "oauth",
      provider,
      ...creds,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export async function setAnthropicApiKey(key: string, agentDir?: string) {
  // Write to the multi-agent path so gateway finds credentials on startup
  upsertAuthProfile({
    profileId: "anthropic:default",
    credential: {
      type: "api_key",
      provider: "anthropic",
      key,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export async function setGeminiApiKey(key: string, agentDir?: string) {
  // Write to the multi-agent path so gateway finds credentials on startup
  upsertAuthProfile({
    profileId: "google:default",
    credential: {
      type: "api_key",
      provider: "google",
      key,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export function applyAuthProfileConfig(
  cfg: ClawdbotConfig,
  params: {
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth";
    email?: string;
    preferProfileFirst?: boolean;
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

  // Only maintain `auth.order` when the user explicitly configured it.
  // Default behavior: no explicit order -> resolveAuthProfileOrder can round-robin by lastUsed.
  const existingProviderOrder = cfg.auth?.order?.[params.provider];
  const preferProfileFirst = params.preferProfileFirst ?? true;
  const reorderedProviderOrder =
    existingProviderOrder && preferProfileFirst
      ? [
          params.profileId,
          ...existingProviderOrder.filter(
            (profileId) => profileId !== params.profileId,
          ),
        ]
      : existingProviderOrder;
  const order =
    existingProviderOrder !== undefined
      ? {
          ...cfg.auth?.order,
          [params.provider]: reorderedProviderOrder?.includes(params.profileId)
            ? reorderedProviderOrder
            : [...(reorderedProviderOrder ?? []), params.profileId],
        }
      : cfg.auth?.order;
  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      profiles,
      ...(order ? { order } : {}),
    },
  };
}

export function applyMinimaxProviderConfig(
  cfg: ClawdbotConfig,
): ClawdbotConfig {
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
      models,
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

export function applyMinimaxConfig(cfg: ClawdbotConfig): ClawdbotConfig {
  const next = applyMinimaxProviderConfig(cfg);
  return {
    ...next,
    agent: {
      ...next.agent,
      model: {
        ...(next.agent?.model &&
        "fallbacks" in (next.agent.model as Record<string, unknown>)
          ? {
              fallbacks: (next.agent.model as { fallbacks?: string[] })
                .fallbacks,
            }
          : undefined),
        primary: "lmstudio/minimax-m2.1-gs32",
      },
    },
  };
}
