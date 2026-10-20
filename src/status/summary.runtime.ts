// Kept behind a lazy surface because status summary imports model/session/runtime metadata helpers.

import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import { resolveSessionStorePathForAcp } from "../acp/runtime/session-meta.js";
import { resolveCurrentSessionAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import {
  resolveAuthoredModelContextTokens,
  resolveContextTokensForModelFromCache as resolveContextTokensForModel,
} from "../agents/context-resolution.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { selectModelCatalogRuntimeEntry } from "../agents/model-catalog-view.js";
import { resolveModelContextWindowProfile } from "../agents/model-context-window.js";
import { resolveConfiguredModelRef } from "../agents/model-selection-shared.js";
import { parseModelRef, resolvePersistedSelectedModelRef } from "../agents/model-selection.js";
import { getPreparedModelCatalogSnapshot } from "../agents/prepared-model-catalog.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import type { SessionEntrySummary } from "../config/sessions/session-accessor.js";
import type { SessionAcpMeta, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { classifySessionKind } from "../sessions/classify-session-kind.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveAgentRuntimeLabel } from "./agent-runtime-label.js";

const staticModelCatalogResolverLoader = createLazyImportLoader(async () => {
  const modelCatalog = await import("../agents/embedded-agent-runner/model.static-catalog.js");
  return {
    resolveManifestModel: modelCatalog.createBundledStaticCatalogModelResolver({
      // Runtime-discovery manifest rows still provide a cold-cache fallback.
      includeRuntimeDiscovery: true,
    }),
    createProviderContextResolver: modelCatalog.createBundledProviderStaticCatalogContextResolver,
  };
});

async function createStatusModelContextResolver(cfg: OpenClawConfig) {
  const { resolveManifestModel, createProviderContextResolver } =
    await staticModelCatalogResolverLoader.load();
  const resolveProviderContext = createProviderContextResolver({ cfg });
  const modelContextCache = new Map<
    string,
    Promise<{ modelContextWindow?: number; modelContextTokens?: number }>
  >();
  return async (
    provider: string | undefined,
    model: string | undefined,
    agentId?: string,
    runtimeId = "openclaw",
    sessionEntry?: SessionEntry,
  ) => {
    if (!provider || !model) {
      return {};
    }
    const ownerAgentId = agentId ?? tryResolveAmbientOwnerAgentId(cfg);
    const catalog = ownerAgentId
      ? getPreparedModelCatalogSnapshot({
          config: cfg,
          agentId: ownerAgentId,
          workspaceDir: sessionEntry?.spawnedWorkspaceDir,
        })
      : undefined;
    if (catalog) {
      const logicalEntry = findModelInCatalog(catalog.entries, provider, model);
      const entry =
        logicalEntry &&
        selectModelCatalogRuntimeEntry({
          entry: logicalEntry,
          routeVariants: catalog.routeVariants,
          runtimeId,
          allowApiFallback: false,
        }).entry;
      return {
        modelContextWindow: resolveModelContextWindowProfile({
          catalogEntry: entry,
          selected: sessionEntry?.contextWindow,
        }).contextTokens,
        modelContextTokens: entry?.contextTokens,
      };
    }
    if (runtimeId !== "openclaw" && runtimeId !== "auto" && runtimeId !== provider) {
      return {};
    }
    const key = `${provider}\0${model}`;
    const cached = modelContextCache.get(key);
    if (cached) {
      return cached;
    }
    const resolved = (async () => {
      try {
        const entry =
          resolveManifestModel({ provider, modelId: model }) ??
          (await resolveProviderContext({ provider, modelId: model }));
        return {
          ...(entry?.contextWindow ? { modelContextWindow: entry.contextWindow } : {}),
          ...(entry?.contextTokens ? { modelContextTokens: entry.contextTokens } : {}),
        };
      } catch {
        return {};
      }
    })();
    modelContextCache.set(key, resolved);
    return resolved;
  };
}

function resolveConfiguredStatusModelRef(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  agentId?: string;
}): { provider: string; model: string } {
  return resolveConfiguredModelRef(
    {
      ...params,
      allowManifestNormalization: false,
      allowPluginNormalization: false,
      // Status must not discover provider metadata; the current snapshot keeps declared
      // providers authoritative without a manifest scan on every status read.
      manifestPlugins:
        getCurrentPluginMetadataSnapshot({ config: params.cfg, env: process.env }) ?? [],
    },
    // Include ACP agent primaries rather than substituting their native fallback.
    "acp",
  );
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
  const overrideModel = normalizeOptionalString(entry?.modelOverride);
  const provider = normalizeOptionalString(
    overrideModel ? entry?.providerOverride : entry?.modelProvider,
  );
  const model = overrideModel ?? normalizeOptionalString(entry?.model);
  if (
    model &&
    !provider &&
    !model.includes("/") &&
    normalizeLowercaseStringOrEmpty(model) !== "openrouter:auto"
  ) {
    // Preserve the selected model's persisted spelling, not an older runtime model's alias.
    return { provider: defaultProvider, model };
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

function resolveStatusAcpSession(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
}) {
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
  return { sessionKey: acpSessionKey, agentId: acpAgentId };
}

async function readSessionRuntimeMetadata(
  cfg: OpenClawConfig,
  candidates: readonly SessionEntrySummary[],
) {
  return readAcpSessionMetaForEntries({
    cfg,
    entries: candidates.map(({ sessionKey, entry }) => ({
      ...resolveStatusAcpSession({
        cfg,
        sessionKey,
        agentId: parseAgentSessionKey(sessionKey)?.agentId,
      }),
      entry,
    })),
  });
}

function resolveSessionRuntime(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  provider: string;
  model: string;
  agentId?: string;
  sessionKey: string;
  acpMeta: SessionAcpMeta | null;
}): { id: string | undefined; label: string } {
  const { sessionKey: acpSessionKey, agentId: acpAgentId } = resolveStatusAcpSession(params);
  const { acpMeta } = params;
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
  const id = normalizeOptionalLowercaseString(
    runtime.id === "auto"
      ? resolveEffectiveAgentRuntime({
          cfg: params.cfg,
          agentId: params.agentId ?? acpAgentId,
          provider: params.provider,
          modelId: params.model,
          sessionKey: acpSessionKey,
          sessionEntry: params.entry,
        })
      : runtime.id,
  );
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
  createStatusModelContextResolver,
  resolveAuthoredModelContextTokens,
  resolveContextTokensForModel,
  classifySessionKey: classifySessionKind,
  resolveSessionModelRef,
  resolveSessionRuntime,
  readSessionRuntimeMetadata,
  resolveConfiguredStatusModelRef,
  resolveStatusModelLookupRef,
  resolveStatusModelComparisonLabel,
};
