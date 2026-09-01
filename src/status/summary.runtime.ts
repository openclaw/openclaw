// Runtime helpers for building status summaries.
// Kept behind a lazy surface because status summary imports model/session/runtime metadata helpers.

import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import {
  readAcpSessionMetaForEntry,
  resolveSessionStorePathForAcp,
} from "../acp/runtime/session-meta.js";
import { resolveCurrentSessionAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import { resolveConfiguredProviderFallback } from "../agents/configured-provider-fallback.js";
import {
  resolveAuthoredModelContextTokens,
  resolveContextTokensForModelFromCache as resolveContextTokensForModel,
} from "../agents/context-resolution.js";
import { waitForContextWindowCacheLoad } from "../agents/context.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  normalizeModelRef,
  resolveModelRefFromString,
  resolvePersistedSelectedModelRef,
} from "../agents/model-selection.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { resolveSessionModelOverrideRouteResolution } from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { classifySessionKind } from "../sessions/classify-session-kind.js";
import { resolveAgentRuntimeLabel } from "./agent-runtime-label.js";

type StatusModelRef = { provider: string; model: string; displayModel?: string };

function resolveStatusDisplayModelRef(provider: string, model: string): StatusModelRef {
  const ref = normalizeModelRef(provider, model, {
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  });
  // Keep authored display text separate from lookup identity. Prepared session
  // refs must not be parsed again just to support providerless legacy aliases.
  return ref.model === model ? ref : { ...ref, displayModel: model };
}

function resolveStatusModelRefFromRaw(params: {
  cfg: OpenClawConfig;
  rawModel: string;
  defaultProvider: string;
}): StatusModelRef | null {
  const trimmed = params.rawModel.trim();
  if (!trimmed) {
    return null;
  }
  const configuredModels = params.cfg.agents?.defaults?.models ?? {};
  if (!trimmed.includes("/")) {
    // Bare model names may be aliases from agents.defaults.models before falling back to default provider.
    const aliasKey = normalizeLowercaseStringOrEmpty(trimmed);
    for (const [modelKey, entry] of Object.entries(configuredModels)) {
      const aliasValue = (entry as { alias?: unknown } | undefined)?.alias;
      const alias = normalizeOptionalString(aliasValue) ?? "";
      if (!alias || normalizeOptionalLowercaseString(alias) !== aliasKey) {
        continue;
      }
      const resolved = resolveModelRefFromString({
        cfg: params.cfg,
        raw: modelKey,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: false,
        allowPluginNormalization: false,
      });
      if (resolved) {
        return resolved.ref;
      }
    }
    return resolveStatusDisplayModelRef(params.defaultProvider, trimmed);
  }
  return (
    resolveModelRefFromString({
      cfg: params.cfg,
      raw: trimmed,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    })?.ref ?? null
  );
}

function resolveConfiguredStatusModelRef(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  agentId?: string;
}): StatusModelRef {
  const agentRawModel = params.agentId
    ? resolveAgentModelPrimaryValue(resolveAgentConfig(params.cfg, params.agentId)?.model)
    : undefined;
  if (agentRawModel) {
    // Agent-specific primary model wins over global defaults for session status rows.
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
    defaultModel: params.defaultModel,
  });
  if (fallbackProvider) {
    return fallbackProvider;
  }

  return { provider: params.defaultProvider, model: params.defaultModel };
}

function resolveProviderlessPersistedStatusModelRef(params: {
  defaultProvider: string;
  provider?: unknown;
  model?: unknown;
}): StatusModelRef | null {
  const provider = normalizeOptionalString(params.provider);
  const model = normalizeOptionalString(params.model);
  if (
    !model ||
    provider ||
    model.includes("/") ||
    normalizeLowercaseStringOrEmpty(model) === "openrouter:auto"
  ) {
    return null;
  }
  return resolveStatusDisplayModelRef(params.defaultProvider, model);
}

function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?: Pick<SessionEntry, "model" | "modelProvider"> &
    Parameters<typeof resolveSessionModelOverrideRouteResolution>[0],
  agentId?: string,
): StatusModelRef {
  const resolved = resolveConfiguredStatusModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    agentId,
  });
  const defaultProvider = resolved.provider || DEFAULT_PROVIDER;
  const providerlessPersisted =
    resolveProviderlessPersistedStatusModelRef({
      defaultProvider,
      provider: entry?.providerOverride,
      model: entry?.modelOverride,
    }) ??
    resolveProviderlessPersistedStatusModelRef({
      defaultProvider,
      provider: entry?.modelProvider,
      model: entry?.model,
    });
  if (providerlessPersisted) {
    return providerlessPersisted;
  }
  return (
    // Persisted selected model or overrides describe the active session, not just current config.
    resolvePersistedSelectedModelRef({
      cfg,
      defaultProvider,
      runtimeProvider: entry?.modelProvider,
      runtimeModel: entry?.model,
      overrideProvider: entry?.providerOverride,
      overrideModel: entry?.modelOverride,
      routeResolution: resolveSessionModelOverrideRouteResolution(entry),
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    }) ?? resolved
  );
}

function resolveSessionRuntime(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  provider: string;
  model: string;
  agentId?: string;
  sessionKey: string;
}): { id: string | undefined; label: string } {
  const acpSessionKey = params.agentId
    ? resolveStoredSessionKeyForAgentStore({
        cfg: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      })
    : params.sessionKey;
  const { agentId: acpAgentId } = resolveSessionStorePathForAcp({
    cfg: params.cfg,
    sessionKey: acpSessionKey,
  });
  // The summary already captured the session generation. Rereading its store
  // could pair runtime metadata with a replacement row and reopen cold history.
  const acpMeta = readAcpSessionMetaForEntry({
    cfg: params.cfg,
    sessionKey: acpSessionKey,
    agentId: acpAgentId,
    entry: params.entry,
  });
  const runtime = resolveCurrentSessionAgentRuntimeMetadata({
    cfg: params.cfg,
    agentId: params.agentId ?? "",
    provider: params.provider,
    model: params.model,
    sessionKey: acpSessionKey,
    sessionEntry: params.entry,
    acpRuntime: acpMeta != null,
    acpBackend: acpMeta?.backend,
  });
  const id = normalizeOptionalLowercaseString(runtime.id);
  // OpenClaw/auto are generic labels; concrete harness ids give better operator signal.
  const resolvedHarness = id && id !== "openclaw" && id !== "auto" ? id : undefined;
  return {
    id,
    label: resolveAgentRuntimeLabel({
      config: params.cfg,
      sessionEntry: params.entry,
      resolvedHarness,
      fallbackProvider: params.provider,
    }),
  };
}

export const statusSummaryRuntime = {
  waitForContextWindowCacheLoad,
  resolveAuthoredModelContextTokens,
  resolveContextTokensForModel,
  classifySessionKey: classifySessionKind,
  resolveSessionModelRef,
  resolveSessionRuntime,
  resolveConfiguredStatusModelRef,
};
