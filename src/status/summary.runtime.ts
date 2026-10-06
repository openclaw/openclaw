// Runtime helpers for building status summaries.
// Kept behind a lazy surface because status summary imports model/session/runtime metadata helpers.

import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta-readonly.js";
import { resolveSessionStorePathForAcp } from "../acp/runtime/session-meta.js";
import { resolveCurrentSessionAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import {
  resolveAuthoredModelContextTokens,
  resolveContextTokensForModelFromCache as resolveContextTokensForModel,
} from "../agents/context-resolution.js";
import { waitForContextWindowCacheLoad } from "../agents/context.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  buildModelAliasIndex,
  resolveConfiguredPrimaryProviderFallback,
} from "../agents/model-selection-shared.js";
import { parseModelRef, resolvePersistedSelectedModelRef } from "../agents/model-selection.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { classifySessionKind } from "../sessions/classify-session-kind.js";
import { resolveAgentRuntimeLabel } from "./agent-runtime-label.js";

function resolveStatusModelRefFromRaw(params: {
  cfg: OpenClawConfig;
  rawModel: string;
  defaultProvider: string;
  agentId?: string;
}): { provider: string; model: string } | null {
  const trimmed = params.rawModel.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.includes("/")) {
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      agentId: params.agentId,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: false,
      allowPluginNormalization: false,
      // Status must not discover provider metadata while resolving configured aliases.
      manifestPlugins: [],
    });
    return (
      aliasIndex.byAlias.get(normalizeLowercaseStringOrEmpty(trimmed))?.ref ?? {
        provider: params.defaultProvider,
        model: trimmed,
      }
    );
  }
  return parseModelRef(trimmed, params.defaultProvider, {
    allowManifestNormalization: false,
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
    ? resolveAgentModelPrimaryValue(resolveAgentConfig(params.cfg, params.agentId)?.model)
    : undefined;
  // Agent-specific primary model wins over global defaults for session status rows.
  for (const rawModel of [
    agentRawModel,
    resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model),
  ]) {
    if (rawModel) {
      const parsed = resolveStatusModelRefFromRaw({
        cfg: params.cfg,
        rawModel,
        defaultProvider: params.defaultProvider,
        agentId: params.agentId,
      });
      if (parsed) {
        return parsed;
      }
    }
  }

  const fallbackProvider = resolveConfiguredPrimaryProviderFallback({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    allowManifestNormalization: false,
    allowPluginNormalization: false,
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
}): { provider: string; model: string } | null {
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
  // Status rows report the persisted session text. Shared ref parsing still
  // canonicalizes provider-local aliases, which would rewrite this display.
  return { provider: params.defaultProvider, model };
}

function resolveStatusModelLookupRef(params: {
  provider?: unknown;
  model?: unknown;
  defaultProvider?: unknown;
}): { provider: string; model: string } | null {
  const provider = normalizeOptionalString(params.provider);
  const model = normalizeOptionalString(params.model);
  if (!model) {
    return null;
  }
  const defaultProvider =
    normalizeOptionalString(params.defaultProvider) ?? provider ?? DEFAULT_PROVIDER;
  const raw = provider ? `${provider}/${model}` : model;
  const parsed = parseModelRef(raw, defaultProvider, {
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  });
  return parsed ?? { provider: provider ?? defaultProvider, model };
}

function resolveStatusModelComparisonLabel(params: {
  provider?: unknown;
  model?: unknown;
  defaultProvider?: unknown;
}): string | null {
  const ref = resolveStatusModelLookupRef(params);
  return ref ? `${ref.provider}/${ref.model}` : null;
}

function resolveSessionModelRef(
  resolved: { provider: string; model: string },
  entry?:
    | SessionEntry
    | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">,
): { provider: string; model: string } {
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
      defaultProvider,
      runtimeProvider: entry?.modelProvider,
      runtimeModel: entry?.model,
      overrideProvider: entry?.providerOverride,
      overrideModel: entry?.modelOverride,
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
    agentId: params.agentId ?? acpAgentId,
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
  resolveStatusModelLookupRef,
  resolveStatusModelComparisonLabel,
};
