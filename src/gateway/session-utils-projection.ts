import { expectDefined } from "@openclaw/normalization-core";
import {
  readAcpSessionMeta,
  readAcpSessionMetaForEntry,
  readAcpSessionMetaBatch,
} from "../acp/runtime/session-meta.js";
import { resolveCurrentSessionAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { findModelCatalogEntry } from "../agents/model-catalog-lookup.js";
import { selectModelCatalogRuntimeEntry } from "../agents/model-catalog-view.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import { captureRuntimeStateEnvironment } from "../config/paths.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import type { GatewayStoredSessionTargets } from "../config/sessions/combined-store-gateway.js";
import { resolveConcreteSessionStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { SynchronousWork } from "../shared/synchronous-work.js";
import type { SessionEntryPair } from "./session-list-order.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { readRecentSessionUsageFromTranscript as readScopedRecentSessionUsageFromTranscript } from "./session-transcript-usage.js";
import {
  createSessionRowModelCacheKey,
  type SessionActorProfileIdentity,
  type SessionListRowContext,
} from "./session-utils-contracts.js";
import { resolveEstimatedSessionCostUsd, resolvePositiveNumber } from "./session-utils-core.js";
import { resolveWorkerPlacementModelRuntime } from "./worker-environments/placement-session-runtime.js";

export function buildSessionListRowMetadataContext(params: {
  now: number;
  sessionKeys?: readonly string[];
  userProfileIdentityById?: Map<string, SessionActorProfileIdentity | undefined>;
}): SessionListRowContext {
  const catalogEntries = new WeakMap<
    ModelCatalogEntry[],
    Map<string, ModelCatalogEntry | undefined>
  >();
  const runtimeEntries = new WeakMap<
    readonly ModelCatalogEntry[],
    Map<string, ReturnType<typeof selectModelCatalogRuntimeEntry>>
  >();
  return {
    subagentRuns: buildSubagentSessionListReadIndex(params.now, params.sessionKeys),
    selectedModelByOverrideRef: new Map(),
    thinkingMetadataByModelRef: new Map(),
    findModelCatalogEntry: (catalog, query) => {
      let entries = catalogEntries.get(catalog);
      if (!entries) {
        entries = new Map();
        catalogEntries.set(catalog, entries);
      }
      const key = createSessionRowModelCacheKey(query.provider, query.modelId);
      if (!entries.has(key)) {
        entries.set(key, findModelCatalogEntry(catalog, query));
      }
      return entries.get(key);
    },
    selectModelCatalogRuntimeEntry: (selection) => {
      let entries = runtimeEntries.get(selection.routeVariants);
      if (!entries) {
        entries = new Map();
        runtimeEntries.set(selection.routeVariants, entries);
      }
      const key = `${selection.runtimeId}\0${createSessionRowModelCacheKey(selection.entry.provider, selection.entry.id)}`;
      let selected = entries.get(key);
      if (!selected) {
        selected = selectModelCatalogRuntimeEntry(selection);
        entries.set(key, selected);
      }
      return selected;
    },
    displayModelIdentityByKey: new Map(),
    modelCostConfigByModelRef: new Map(),
    userProfileIdentityById: params.userProfileIdentityById ?? new Map(),
    acpSessionMetaByEntry: new Map(),
  };
}

export function resolveTranscriptUsageFallback(params: {
  cfg: OpenClawConfig;
  key: string;
  entry?: SessionEntry;
  storePath: string;
  freshTotalTokens?: number;
  fallbackModelRef?: string;
  allowPluginNormalization?: boolean;
  maxTranscriptBytes?: number;
  rowContext?: SessionListRowContext;
  agentId: string;
}): {
  estimatedCostUsd?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
} | null {
  const { entry, agentId } = params;
  if (!entry?.sessionId) {
    return null;
  }
  const resolvedModel = resolveSessionModelIdentityRef(
    params.cfg,
    entry,
    agentId,
    params.fallbackModelRef,
    { allowPluginNormalization: params.allowPluginNormalization },
  );
  if (
    params.freshTotalTokens !== undefined &&
    resolveEstimatedSessionCostUsd({
      cfg: params.cfg,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      entry,
      rowContext: params.rowContext,
    }) !== undefined
  ) {
    return null;
  }
  const storePath =
    resolveConcreteSessionStorePath(params.storePath) ??
    resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  let snapshot: ReturnType<typeof readScopedRecentSessionUsageFromTranscript>;
  try {
    snapshot = readScopedRecentSessionUsageFromTranscript(
      {
        agentId,
        sessionEntry: entry,
        sessionId: entry.sessionId,
        sessionKey: params.key,
        storePath,
      },
      typeof params.maxTranscriptBytes === "number" ? params.maxTranscriptBytes : 256 * 1024,
    );
  } catch {
    return null;
  }
  if (!snapshot) {
    return null;
  }
  const estimatedCostUsd = resolveEstimatedSessionCostUsd({
    cfg: params.cfg,
    provider: snapshot.modelProvider ?? resolvedModel.provider,
    model: snapshot.model ?? resolvedModel.model,
    explicitCostUsd: snapshot.costUsd,
    entry: {
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      cacheRead: snapshot.cacheRead,
      cacheWrite: snapshot.cacheWrite,
    },
    rowContext: params.rowContext,
  });
  return {
    totalTokens: resolvePositiveNumber(snapshot.totalTokens),
    totalTokensFresh: snapshot.totalTokensFresh === true,
    estimatedCostUsd,
  };
}

export function* populateSessionListAcpMetadataWork(params: {
  cfg: OpenClawConfig;
  entries: readonly SessionEntryPair[];
  targetsBySessionKey: GatewayStoredSessionTargets;
  rowContext?: SessionListRowContext;
}): SynchronousWork<void> {
  const metadataByEntry = params.rowContext?.acpSessionMetaByEntry;
  if (!metadataByEntry || params.entries.length === 0) {
    return;
  }
  // Ordinary rows need two database keys each; keep preparation and its reads bounded.
  const batchSize = 250;
  for (let start = 0; start < params.entries.length; start += batchSize) {
    const entries = params.entries
      .slice(start, start + batchSize)
      .filter(([, entry]) => !metadataByEntry.has(entry))
      .map(([key, entry]) => {
        const target = expectDefined(params.targetsBySessionKey.get(key), "ACP row owner");
        const agentId = target.agentId;
        return {
          sessionKey: resolveStoredSessionKeyForAgentStore({
            cfg: params.cfg,
            agentId,
            sessionKey: target.storeKey ?? key,
          }),
          agentId,
          entry,
        };
      });
    if (entries.length > 0) {
      const metadata = readAcpSessionMetaBatch({ entries, cfg: params.cfg });
      // Record absent metadata too, so selected rows do not repeat missing-store reads.
      for (const { entry } of entries) {
        metadataByEntry.set(entry, metadata.get(entry));
      }
    }
    // The database read scope closes before the caller can yield to another request.
    yield;
  }
}

/** Runtime ownership is independent of whether the model itself can change. */
export function resolveGatewaySessionRuntimeSelectionLocked(
  entry: Pick<SessionEntry, "modelSelectionLocked"> | undefined,
  acpMeta: SessionEntry["acp"],
): boolean {
  return entry?.modelSelectionLocked === true || acpMeta != null;
}

export function resolveGatewaySessionRuntimeProjection(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId: string;
  sessionKey: string;
  entry?: SessionEntry;
  rowContext?: SessionListRowContext;
  metadataSnapshot?: PluginMetadataSnapshot;
}) {
  const { cfg, agentId, sessionKey, entry } = params;
  const cachedAcpMeta = params.rowContext?.acpSessionMetaByEntry;
  // Keep metadata bound to the projected row; rereading its key can adopt a
  // replacement lifecycle while projecting the original entry.
  const acpMeta =
    entry?.acp ??
    (entry && cachedAcpMeta?.has(entry)
      ? cachedAcpMeta.get(entry)
      : entry
        ? readAcpSessionMetaForEntry({ cfg, sessionKey, agentId, entry })
        : readAcpSessionMeta({ sessionKey, agentId }));
  const agentRuntime = resolveCurrentSessionAgentRuntimeMetadata({
    cfg: params.cfg,
    agentScope: { kind: "prepared", agentId: params.agentId },
    provider: params.provider,
    model: params.model,
    sessionKey: params.sessionKey,
    sessionEntry: params.entry,
    acpRuntime: acpMeta != null,
    acpBackend: acpMeta?.backend,
  });
  if (agentRuntime.id === "auto" && entry) {
    agentRuntime.id = resolveWorkerPlacementModelRuntime({
      ...params,
      entry,
      preparedEnvironment: params.rowContext
        ? (params.rowContext.workerPlacementEnvironment ??= captureRuntimeStateEnvironment())
        : undefined,
    });
  }
  return {
    acpMeta,
    agentRuntime,
    runtimeSelectionLocked: resolveGatewaySessionRuntimeSelectionLocked(entry, acpMeta),
  };
}
