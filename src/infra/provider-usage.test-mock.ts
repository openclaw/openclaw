import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchCopilotUsage } from "../../extensions/github-copilot/usage.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import {
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchGeminiUsage,
  fetchMinimaxUsage,
  fetchZaiUsage,
} from "./provider-usage.fetch.js";
import { PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { UsageProviderId } from "./provider-usage.types.js";

type ResolveUsageAuthParams = {
  provider: string;
  context: {
    env: NodeJS.ProcessEnv;
    resolveApiKeyFromConfigAndStore: (options?: {
      providerIds?: string[];
      envDirect?: Array<string | undefined>;
    }) => string | undefined;
    resolveOAuthToken: () => Promise<{ token: string; accountId?: string } | null>;
  };
};

type ResolveUsageSnapshotParams = {
  provider: string;
  context: {
    token: string;
    accountId?: string;
    timeoutMs: number;
    fetchFn: typeof fetch;
  };
};

function parseGoogleUsageToken(apiKey: string): string {
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown };
    if (typeof parsed?.token === "string") {
      return parsed.token;
    }
  } catch {
    // ignore
  }
  return apiKey;
}

function resolveLegacyZaiUsageToken(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const authPath = path.join(
      resolveRequiredHomeDir(env, os.homedir),
      ".pi",
      "agent",
      "auth.json",
    );
    if (!fs.existsSync(authPath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<
      string,
      { access?: string }
    >;
    return parsed["z-ai"]?.access || parsed.zai?.access;
  } catch {
    return undefined;
  }
}

export async function resolveProviderUsageAuthWithPlugin(params: ResolveUsageAuthParams) {
  switch (params.provider) {
    case "anthropic":
    case "github-copilot":
    case "openai-codex":
      return await params.context.resolveOAuthToken();
    case "google-gemini-cli": {
      const auth = await params.context.resolveOAuthToken();
      if (!auth) {
        return null;
      }
      return {
        ...auth,
        token: parseGoogleUsageToken(auth.token),
      };
    }
    case "minimax": {
      const token = params.context.resolveApiKeyFromConfigAndStore({
        envDirect: [params.context.env.MINIMAX_CODE_PLAN_KEY, params.context.env.MINIMAX_API_KEY],
      });
      return token ? { token } : null;
    }
    case "xiaomi": {
      const token = params.context.resolveApiKeyFromConfigAndStore({
        envDirect: [params.context.env.XIAOMI_API_KEY],
      });
      return token ? { token } : null;
    }
    case "zai": {
      const token = params.context.resolveApiKeyFromConfigAndStore({
        providerIds: ["zai", "z-ai"],
        envDirect: [params.context.env.ZAI_API_KEY, params.context.env.Z_AI_API_KEY],
      });
      if (token) {
        return { token };
      }
      const legacyToken = resolveLegacyZaiUsageToken(params.context.env);
      return legacyToken ? { token: legacyToken } : null;
    }
    default:
      return null;
  }
}

export async function resolveProviderUsageSnapshotWithPlugin(params: ResolveUsageSnapshotParams) {
  switch (params.provider as UsageProviderId) {
    case "anthropic":
      return await fetchClaudeUsage(
        params.context.token,
        params.context.timeoutMs,
        params.context.fetchFn,
      );
    case "github-copilot":
      return await fetchCopilotUsage(
        params.context.token,
        params.context.timeoutMs,
        params.context.fetchFn,
      );
    case "google-gemini-cli":
      return await fetchGeminiUsage(
        params.context.token,
        params.context.timeoutMs,
        params.context.fetchFn,
        "google-gemini-cli",
      );
    case "minimax":
      return await fetchMinimaxUsage(
        params.context.token,
        params.context.timeoutMs,
        params.context.fetchFn,
      );
    case "openai-codex":
      return await fetchCodexUsage(
        params.context.token,
        params.context.accountId,
        params.context.timeoutMs,
        params.context.fetchFn,
      );
    case "xiaomi":
      return {
        provider: "xiaomi",
        displayName: PROVIDER_LABELS.xiaomi,
        windows: [],
      };
    case "zai":
      return await fetchZaiUsage(
        params.context.token,
        params.context.timeoutMs,
        params.context.fetchFn,
      );
    default:
      return null;
  }
}
