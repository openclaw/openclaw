import { resolveConfiguredProviderFallback } from "../agents/configured-provider-fallback.js";
import { resolveContextTokensForModel as resolveSharedContextTokensForModel } from "../agents/context.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { parseModelRef, resolvePersistedSelectedModelRef } from "../agents/model-selection.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";

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
    const aliasKey = normalizeLowercaseStringOrEmpty(trimmed);
    for (const [modelKey, entry] of Object.entries(configuredModels)) {
      const aliasValue = (entry as { alias?: unknown } | undefined)?.alias;
      const alias = normalizeOptionalString(aliasValue) ?? "";
      if (!alias || normalizeOptionalLowercaseString(alias) !== aliasKey) {
        continue;
      }
      const parsed = parseModelRef(modelKey, params.defaultProvider, {
        allowPluginNormalization: false,
      });
      if (parsed) {
        return parsed;
      }
    }
    return { provider: params.defaultProvider, model: trimmed };
  }
  return parseModelRef(trimmed, params.defaultProvider, {
    allowPluginNormalization: false,
  });
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
    resolvePersistedSelectedModelRef({
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
  return resolveSharedContextTokensForModel(params);
}

export const statusSummaryRuntime = {
  resolveContextTokensForModel,
  classifySessionKey,
  resolveSessionModelRef,
  resolveConfiguredStatusModelRef,
};
