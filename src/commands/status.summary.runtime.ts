import { resolveConfiguredProviderFallback } from "../agents/configured-provider-fallback.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolvePersistedModelRef } from "../agents/model-selection.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";

function parseStatusModelRef(
  raw: string,
  defaultProvider: string,
): { provider: string; model: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return { provider: defaultProvider, model: trimmed };
  }
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function resolveStatusModelRefFromRaw(params: {
  cfg: OpenClawConfig;
  rawModel: string;
  defaultProvider: string;
}): { provider: string; model: string } | null {
  const trimmed = params.rawModel.trim();
  if (!trimmed) {
    return null;
  }
  const configuredModels = params.cfg.agents?.defaults?.models ?? {};
  if (!trimmed.includes("/")) {
    const aliasKey = trimmed.toLowerCase();
    for (const [modelKey, entry] of Object.entries(configuredModels)) {
      const aliasValue = (entry as { alias?: unknown } | undefined)?.alias;
      const alias = typeof aliasValue === "string" ? aliasValue.trim() : "";
      if (!alias || alias.toLowerCase() !== aliasKey) {
        continue;
      }
      const parsed = parseStatusModelRef(modelKey, params.defaultProvider);
      if (parsed) {
        return parsed;
      }
    }
    return { provider: "anthropic", model: trimmed };
  }
  return parseStatusModelRef(trimmed, params.defaultProvider);
}

function resolveConfiguredStatusModelRef(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  agentId?: string;
}): { provider: string; model: string } {
  const agentRawModel = params.agentId
    ? resolveAgentModelPrimaryValue(
        params.cfg.agents?.list?.find((entry) => entry?.id === params.agentId)?.model,
      )
    : undefined;
  if (agentRawModel) {
    const parsed = resolveStatusModelRefFromRaw({
      cfg: params.cfg,
      rawModel: agentRawModel,
      defaultProvider: params.defaultProvider,
    });
    if (parsed) {
      return parsed;
    }
  }

  const defaultsRawModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model);
  if (defaultsRawModel) {
    const parsed = resolveStatusModelRefFromRaw({
      cfg: params.cfg,
      rawModel: defaultsRawModel,
      defaultProvider: params.defaultProvider,
    });
    if (parsed) {
      return parsed;
    }
  }

  const fallbackProvider = resolveConfiguredProviderFallback({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  if (fallbackProvider) {
    return fallbackProvider;
  }

  return { provider: params.defaultProvider, model: params.defaultModel };
}

function resolveConfiguredProviderContextWindow(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): number | undefined {
  const providers = cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  for (const [id, providerConfig] of Object.entries(providers)) {
    if (normalizeProviderId(id) !== providerKey || !Array.isArray(providerConfig?.models)) {
      continue;
    }
    for (const entry of providerConfig.models) {
      if (
        typeof entry?.id === "string" &&
        entry.id === model &&
        typeof entry.contextWindow === "number" &&
        entry.contextWindow > 0
      ) {
        return entry.contextWindow;
      }
    }
  }
  return undefined;
}

function classifySessionKey(key: string, entry?: SessionEntry) {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
}

function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?:
    | SessionEntry
    | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">,
  agentId?: string,
): { provider: string; model: string } {
  const resolved = resolveConfiguredStatusModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    agentId,
  });
  return (
    resolvePersistedModelRef({
      defaultProvider: resolved.provider || DEFAULT_PROVIDER,
      runtimeProvider: entry?.modelProvider,
      runtimeModel: entry?.model,
      overrideProvider: entry?.providerOverride,
      overrideModel: entry?.modelOverride,
    }) ?? resolved
  );
}

function resolveContextTokensForModel(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  contextTokensOverride?: number;
  fallbackContextTokens?: number;
  allowAsyncLoad?: boolean;
}): number | undefined {
  void params.allowAsyncLoad;
  if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) {
    return params.contextTokensOverride;
  }
  if (params.provider && params.model) {
    const configuredWindow = resolveConfiguredProviderContextWindow(
      params.cfg,
      params.provider,
      params.model,
    );
    if (configuredWindow !== undefined) {
      return configuredWindow;
    }
  }
  return params.fallbackContextTokens ?? DEFAULT_CONTEXT_TOKENS;
}

export const statusSummaryRuntime = {
  resolveContextTokensForModel,
  classifySessionKey,
  resolveSessionModelRef,
  resolveConfiguredStatusModelRef,
};
