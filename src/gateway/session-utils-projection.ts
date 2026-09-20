import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta-readonly.js";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { resolveCurrentSessionAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { findModelCatalogEntry } from "../agents/model-catalog-lookup.js";
import { selectModelCatalogRuntimeEntry } from "../agents/model-catalog-view.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import { captureRuntimeStateEnvironment } from "../config/paths.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { resolveConcreteSessionStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildProjectedAgentRunIndex,
  resolveProjectedAgentRunProgressState,
  type ProjectedAgentRunIndex,
} from "../infra/agent-run-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
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
  subagentRuns?: SessionListRowContext["subagentRuns"];
  projectedAgentRuns?: ProjectedAgentRunIndex;
  userProfileIdentityById?: Map<string, SessionActorProfileIdentity | undefined>;
}): SessionListRowContext {
  const subagentRuns =
    params.subagentRuns ?? buildSubagentSessionListReadIndex(params.now, params.sessionKeys);
  const projectedAgentRuns = params.projectedAgentRuns ?? buildProjectedAgentRunIndex();
  const catalogEntries = new WeakMap<
    ModelCatalogEntry[],
    Map<string, ModelCatalogEntry | undefined>
  >();
  const runtimeEntries = new WeakMap<
    readonly ModelCatalogEntry[],
    Map<string, ReturnType<typeof selectModelCatalogRuntimeEntry>>
  >();
  return {
    subagentRuns,
    projectedAgentRuns,
    projectedSubagentActivity: buildProjectedSubagentActivity(subagentRuns, projectedAgentRuns),
    subagentRunsByChildSessionKey: subagentRuns.runsByChildSessionKey,
    configuredDefaultModelByAgent: new Map(),
    thinkingFactsByModelRef: new Map(),
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
  };
}

/** Prepare follow-up ancestor membership with the indexes, outside per-row presentation. */
export function buildProjectedSubagentActivity(
  subagentRuns: SessionListRowContext["subagentRuns"],
  projectedAgentRuns: ProjectedAgentRunIndex,
): ReadonlySet<string> {
  const active = new Set<string>();
  if (
    projectedAgentRuns.sessionKeys.size === 0 &&
    projectedAgentRuns.sessionIds.size === 0 &&
    projectedAgentRuns.ownerlessSessionKeys.size === 0 &&
    projectedAgentRuns.ownerlessSessionIds.size === 0
  ) {
    return active;
  }
  for (const [key, run] of subagentRuns.latestRunsByChildSessionKey) {
    if (
      resolveProjectedAgentRunProgressState({ sessionKeys: [key], index: projectedAgentRuns }) ===
      undefined
    ) {
      continue;
    }
    let requester = run.requesterSessionKey;
    while (requester && !active.has(requester)) {
      active.add(requester);
      requester =
        subagentRuns.latestRunsByChildSessionKey.get(requester)?.requesterSessionKey ?? "";
    }
  }
  return active;
}

export function resolveTranscriptUsageFallbacks(params: {
  cfg: OpenClawConfig;
  key: string;
  entry?: SessionEntry;
  storePath: string;
  freshTotalTokens?: number;
  fallbackModelRefs: readonly (string | undefined)[];
  allowPluginNormalization?: boolean;
  maxTranscriptBytes?: number;
  rowContext?: SessionListRowContext;
  agentId: string;
  storeAgentId?: string;
}): Map<
  string | undefined,
  { estimatedCostUsd?: number; totalTokens?: number; totalTokensFresh?: boolean } | null
> {
  const { entry, agentId } = params;
  const fallbacks: ReturnType<typeof resolveTranscriptUsageFallbacks> = new Map();
  let snapshot: ReturnType<typeof readScopedRecentSessionUsageFromTranscript> | undefined;
  for (const fallbackModelRef of new Set(params.fallbackModelRefs)) {
    fallbacks.set(fallbackModelRef, null);
    if (!entry?.sessionId) {
      continue;
    }
    const resolvedModel = resolveSessionModelIdentityRef(
      params.cfg,
      entry,
      agentId,
      fallbackModelRef,
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
      continue;
    }
    if (snapshot === undefined) {
      const storePath =
        resolveConcreteSessionStorePath(params.storePath) ??
        resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
      try {
        snapshot = readScopedRecentSessionUsageFromTranscript(
          {
            agentId: params.storeAgentId ?? agentId,
            sessionEntry: entry,
            sessionId: entry.sessionId,
            sessionKey: params.key,
            storePath,
          },
          typeof params.maxTranscriptBytes === "number" ? params.maxTranscriptBytes : 256 * 1024,
        );
      } catch {
        snapshot = null;
      }
    }
    if (snapshot) {
      const estimatedCostUsd = resolveEstimatedSessionCostUsd({
        cfg: params.cfg,
        provider: snapshot.modelProvider ?? resolvedModel.provider,
        model: snapshot.model ?? resolvedModel.model,
        explicitCostUsd: snapshot.costUsd,
        entry: snapshot,
        rowContext: params.rowContext,
      });
      fallbacks.set(fallbackModelRef, {
        totalTokens: resolvePositiveNumber(snapshot.totalTokens),
        totalTokensFresh: snapshot.totalTokensFresh === true,
        estimatedCostUsd,
      });
    }
  }
  return fallbacks;
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
  // Keep metadata bound to the projected row; rereading its key can adopt a
  // replacement lifecycle while projecting the original entry.
  const acpMeta =
    entry?.acp ??
    (entry
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
