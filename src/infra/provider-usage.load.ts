import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { resolveProviderUsageSnapshotWithPlugin } from "../plugins/provider-runtime.js";
import { resolveFetch } from "./fetch.js";
import { type ProviderAuth, resolveProviderAuths } from "./provider-usage.auth.js";
import {
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchGeminiUsage,
  fetchMinimaxUsage,
  fetchZaiUsage,
} from "./provider-usage.fetch.js";
import {
  DEFAULT_TIMEOUT_MS,
  ignoredErrors,
  PROVIDER_LABELS,
  usageProviders,
  withTimeout,
} from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "./provider-usage.types.js";

async function fetchCopilotUsageFallback(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchFn("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `token ${token}`,
      "Editor-Version": "vscode/1.96.2",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-Github-Api-Version": "2025-04-01",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    return {
      provider: "github-copilot",
      displayName: PROVIDER_LABELS["github-copilot"],
      windows: [],
      error: `HTTP ${res.status}`,
    };
  }
  const data = (await res.json()) as {
    quota_snapshots?: {
      premium_interactions?: { percent_remaining?: number | null };
      chat?: { percent_remaining?: number | null };
    };
    copilot_plan?: string;
  };
  const windows = [];
  const premiumRemaining = data.quota_snapshots?.premium_interactions?.percent_remaining;
  if (premiumRemaining !== undefined && premiumRemaining !== null) {
    windows.push({
      label: "Premium",
      usedPercent: Math.max(0, Math.min(100, 100 - premiumRemaining)),
    });
  }
  const chatRemaining = data.quota_snapshots?.chat?.percent_remaining;
  if (chatRemaining !== undefined && chatRemaining !== null) {
    windows.push({ label: "Chat", usedPercent: Math.max(0, Math.min(100, 100 - chatRemaining)) });
  }
  return {
    provider: "github-copilot",
    displayName: PROVIDER_LABELS["github-copilot"],
    windows,
    plan: data.copilot_plan,
  };
}

async function fetchProviderUsageSnapshotFallback(params: {
  auth: ProviderAuth;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  switch (params.auth.provider) {
    case "anthropic":
      return await fetchClaudeUsage(params.auth.token, params.timeoutMs, params.fetchFn);
    case "github-copilot":
      return await fetchCopilotUsageFallback(params.auth.token, params.timeoutMs, params.fetchFn);
    case "google-gemini-cli":
      return await fetchGeminiUsage(
        params.auth.token,
        params.timeoutMs,
        params.fetchFn,
        "google-gemini-cli",
      );
    case "openai-codex":
      return await fetchCodexUsage(
        params.auth.token,
        params.auth.accountId,
        params.timeoutMs,
        params.fetchFn,
      );
    case "zai":
      return await fetchZaiUsage(params.auth.token, params.timeoutMs, params.fetchFn);
    case "minimax":
      return await fetchMinimaxUsage(params.auth.token, params.timeoutMs, params.fetchFn);
    case "xiaomi":
      return {
        provider: "xiaomi",
        displayName: PROVIDER_LABELS.xiaomi,
        windows: [],
      };
    default:
      return {
        provider: params.auth.provider,
        displayName: PROVIDER_LABELS[params.auth.provider],
        windows: [],
        error: "Unsupported provider",
      };
  }
}

type UsageSummaryOptions = {
  now?: number;
  timeoutMs?: number;
  providers?: UsageProviderId[];
  auth?: ProviderAuth[];
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
    provider: params.auth.provider,
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
      timeoutMs: params.timeoutMs,
      fetchFn: params.fetchFn,
    },
  });
  if (pluginSnapshot) {
    return pluginSnapshot;
  }
  return await fetchProviderUsageSnapshotFallback({
    auth: params.auth,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
  });
}

export async function loadProviderUsageSummary(
  opts: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const config = opts.config ?? loadConfig();
  const env = opts.env ?? process.env;
  const fetchFn = resolveFetch(opts.fetch);
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }

  const auths = await resolveProviderAuths({
    providers: opts.providers ?? usageProviders,
    auth: opts.auth,
    agentDir: opts.agentDir,
  });
  if (auths.length === 0) {
    return { updatedAt: now, providers: [] };
  }

  const tasks = auths.map((auth) =>
    withTimeout(
      fetchProviderUsageSnapshot({
        auth,
        config,
        env,
        agentDir: opts.agentDir,
        workspaceDir: opts.workspaceDir,
        timeoutMs,
        fetchFn,
      }),
      timeoutMs + 1000,
      {
        provider: auth.provider,
        displayName: PROVIDER_LABELS[auth.provider],
        windows: [],
        error: "Timeout",
      },
    ),
  );

  const snapshots = await Promise.all(tasks);
  const providers = snapshots.filter((entry) => {
    if (entry.windows.length > 0) {
      return true;
    }
    if (!entry.error) {
      return true;
    }
    return !ignoredErrors.has(entry.error);
  });

  return { updatedAt: now, providers };
}
