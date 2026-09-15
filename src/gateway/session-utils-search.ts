import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { ModelManifestNormalizationContext } from "../agents/model-ref-shared.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import {
  buildGroupDisplayName,
  type InternalSessionEntry,
  type SessionEntry,
} from "../config/sessions.js";
import type { GatewayStoredSessionTargets } from "../config/sessions/combined-store-gateway.js";
import type { SessionEntryReadSource } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatAgentRuntimeLabel } from "../shared/agent-runtime-display.js";
import { formatGoalSummary } from "../shared/session-goal-display.js";
import { isSessionRunActive } from "../shared/session-run-state.js";
import type { SynchronousWork } from "../shared/synchronous-work.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.shared.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";
import { readPreparedGatewayModelCatalogMetadata } from "./server-model-catalog-view.js";
import type { SessionEntryPair } from "./session-list-order.js";
import type {
  SessionListActiveRunProjector,
  SessionListRowContext,
  SessionListRowContextProvider,
} from "./session-utils-contracts.js";
import {
  resolveGatewaySessionDisplayName,
  resolveGatewaySessionKind,
  projectGatewaySessionRunState,
  projectGatewaySessionActiveRun,
  resolveGatewaySessionGoal,
} from "./session-utils-display.js";
import { resolveSessionSelectedModelRef } from "./session-utils-model-selection.js";
import { resolveSessionDisplayModelIdentityRefCached } from "./session-utils-model.js";
import {
  buildSessionListRowMetadataContext,
  resolveGatewaySessionRuntimeProjection,
  populateSessionListAcpMetadataWork,
} from "./session-utils-projection.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";
import { createGatewaySessionEntryReader } from "./session-utils-store-lookup.js";
import {
  isGroupOrChannelDisplaySession,
  loadGatewaySessionEntryReadOnly,
  parseGroupKey,
} from "./session-utils-store.js";
import type { GatewaySessionRow, SessionListModelCatalog } from "./session-utils.types.js";

function resolveSessionListSearchDisplayName(
  key: string,
  entry?: SessionEntry,
): string | undefined {
  if (entry?.displayName) {
    return entry.displayName;
  }
  const parsed = parseGroupKey(key);
  const channel = sessionDeliveryChannel(entry) ?? parsed?.channel;
  if (isGroupOrChannelDisplaySession(entry, parsed) && channel) {
    return buildGroupDisplayName({
      provider: channel,
      subject: entry?.subject,
      groupChannel: entry?.groupChannel,
      space: entry?.space,
      id: parsed?.id,
      key,
    });
  }
  return entry?.label ?? sessionDeliveryOrigin(entry)?.label;
}

function addSessionListSearchModelFields(
  fields: Array<string | undefined>,
  identity: { provider?: string; model?: string },
) {
  const provider = normalizeOptionalString(identity.provider);
  const model = normalizeOptionalString(identity.model);
  fields.push(provider, model);
  if (provider && model) {
    fields.push(`${provider}/${model}`);
  }
}

function matchesSessionListSearch(fields: Array<string | undefined>, search: string): boolean {
  return fields.some(
    (field) => typeof field === "string" && normalizeLowercaseStringOrEmpty(field).includes(search),
  );
}

function shouldResolveDerivedSessionModelSearchFields(search: string): boolean {
  // Preserve key-query semantics: derived model aliases are not agent-key matches.
  return !search.startsWith("agent:");
}

function resolveSessionListSearchModelFields(
  params: {
    agentId: string;
    cfg: OpenClawConfig;
    key: string;
    entry?: SessionEntry;
    rowContext: SessionListRowContext;
    selectedModel: ReturnType<typeof resolveSessionSelectedModelRef>;
  } & ModelManifestNormalizationContext,
): Array<string | undefined> {
  const { agentId, selectedModel } = params;
  const subagentRun = params.rowContext.subagentRuns.getDisplaySubagentRun(params.key);
  const resolvedModel = resolveSessionModelIdentityRef(
    params.cfg,
    params.entry,
    agentId,
    subagentRun?.model,
    { allowPluginNormalization: false, manifestPlugins: params.manifestPlugins },
  );
  const displayModelIdentity = resolveSessionDisplayModelIdentityRefCached({
    cfg: params.cfg,
    provider: selectedModel.provider,
    model: selectedModel.model,
    rowContext: params.rowContext,
  });
  const fields: Array<string | undefined> = [];
  addSessionListSearchModelFields(fields, {
    provider: params.entry?.modelProvider,
    model: params.entry?.model,
  });
  addSessionListSearchModelFields(fields, resolvedModel);
  addSessionListSearchModelFields(fields, selectedModel);
  addSessionListSearchModelFields(fields, displayModelIdentity);
  return fields;
}

export function createSessionListSearchMatcher(params: {
  cfg: OpenClawConfig;
  search: string;
  targetsBySessionKey: GatewayStoredSessionTargets;
  modelCatalog?: SessionListModelCatalog;
  now: number;
  visibleEntries: readonly SessionEntryPair[];
  getRowContext?: SessionListRowContextProvider;
  projectActiveRun?: SessionListActiveRunProjector;
}) {
  const { cfg, search, now } = params;
  const identityNames = new Map<string, string>();
  let rowContext: SessionListRowContext | undefined;
  const context = () =>
    (rowContext ??= params.getRowContext?.() ?? buildSessionListRowMetadataContext({ now }));
  let acpPrepared = false;
  return function* (key: string, entry: SessionEntry): SynchronousWork<boolean> {
    const target = expectDefined(params.targetsBySessionKey.get(key), "search row owner");
    const storeKey = target.storeKey ?? key;
    const fields = [
      storeKey,
      entry.label,
      entry.subject,
      entry.sessionId,
      entry.category,
      resolveSessionListSearchDisplayName(storeKey, entry),
      resolveGatewaySessionDisplayName(storeKey, entry),
      resolveGatewaySessionKind(storeKey, entry),
    ];
    addSessionListSearchModelFields(fields, { provider: entry.modelProvider, model: entry.model });
    if (matchesSessionListSearch(fields, search)) {
      return true;
    }
    const agentId = target.agentId;
    const metadataSnapshot = readPreparedGatewayModelCatalogMetadata(
      params.modelCatalog?.get(agentId),
    );
    const run = projectGatewaySessionRunState({
      key: storeKey,
      entry,
      now,
      rowContext: context(),
    }).fields;
    const active = params.projectActiveRun?.(key, entry, agentId);
    const state = projectGatewaySessionActiveRun(active, run.status);
    const goal = resolveGatewaySessionGoal(entry, now);
    if (
      matchesSessionListSearch(
        [
          state.status,
          isSessionRunActive(state)
            ? "live running"
            : state.hasActiveRun === false
              ? "idle"
              : undefined,
          goal
            ? `${goal.objective} ${goal.status} ${formatGoalSummary(goal)} ${goal.lastStatusNote ?? ""}`
            : undefined,
        ],
        search,
      )
    ) {
      return true;
    }
    if (!identityNames.has(agentId)) {
      identityNames.set(agentId, resolveAssistantIdentity({ cfg, agentId }).name);
    }
    if (matchesSessionListSearch([identityNames.get(agentId)], search)) {
      return true;
    }
    const selected = resolveSessionSelectedModelRef({
      cfg,
      sessionKey: storeKey,
      source: target.modelSource,
      agentId,
      rowContext: context(),
      allowPluginNormalization: false,
      manifestPlugins: metadataSnapshot,
    });
    if (
      shouldResolveDerivedSessionModelSearchFields(search) &&
      matchesSessionListSearch(
        resolveSessionListSearchModelFields({
          cfg,
          key: storeKey,
          entry,
          agentId,
          rowContext: context(),
          selectedModel: selected,
          manifestPlugins: metadataSnapshot,
        }),
        search,
      )
    ) {
      return true;
    }
    if (!acpPrepared) {
      yield* populateSessionListAcpMetadataWork({
        cfg,
        entries: params.visibleEntries,
        targetsBySessionKey: params.targetsBySessionKey,
        rowContext: context(),
      });
      acpPrepared = true;
    }
    const { agentRuntime } = resolveGatewaySessionRuntimeProjection({
      cfg,
      sessionKey: storeKey,
      entry,
      agentId,
      provider: selected.provider,
      model: selected.model,
      metadataSnapshot,
      rowContext: context(),
    });
    return matchesSessionListSearch([formatAgentRuntimeLabel(agentRuntime)], search);
  };
}

type LoadGatewaySessionRowOptions = {
  agentId?: string;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  now?: number;
  transcriptUsageMaxBytes?: number;
  includeSwarmSummary?: boolean;
};

function loadGatewaySessionSnapshot(
  sessionKey: string,
  options?: LoadGatewaySessionRowOptions,
  lightweight = false,
): { lifecycleRunId?: string; row: GatewaySessionRow | null } {
  const now = options?.now ?? Date.now();
  const { cfg, agentId, storePath, store, entry, canonicalKey, readSource } =
    loadGatewaySessionEntryReadOnly(sessionKey, {
      clone: false,
      includeStoreChildEntries: true,
      projection: lightweight ? "list" : "full",
      agentId: options?.agentId,
    });
  if (!entry) {
    return { row: null };
  }
  const rowContext = options?.includeSwarmSummary
    ? buildSessionListRowMetadataContext({ now })
    : undefined;
  const lifecycleRunId = (entry as InternalSessionEntry).lifecycleRunId;
  return {
    ...(lifecycleRunId === undefined ? {} : { lifecycleRunId }),
    row: buildGatewaySessionRow({
      cfg,
      storePath,
      store,
      modelSource: {
        entry,
        loadSessionEntry: createGatewaySessionEntryReader({ cfg, agentId, store, readSource }),
      },
      key: canonicalKey,
      entry,
      now,
      includeDerivedTitles: options?.includeDerivedTitles,
      includeLastMessage: options?.includeLastMessage,
      transcriptUsageMaxBytes: options?.transcriptUsageMaxBytes,
      skipTranscriptUsageFallback: lightweight,
      lightweightListRow: lightweight,
      agentId,
      // Event snapshots carry complete counts, while ordinary exact-row reads stay scoped.
      rowContext,
    }),
  };
}

export function loadGatewaySessionLifecycleSnapshot(
  sessionKey: string,
  options?: LoadGatewaySessionRowOptions,
): { lifecycleRunId?: string; row: GatewaySessionRow | null } {
  return loadGatewaySessionSnapshot(sessionKey, options, true);
}

export function loadGatewaySessionRow(
  sessionKey: string,
  options?: LoadGatewaySessionRowOptions,
): GatewaySessionRow | null {
  return loadGatewaySessionSnapshot(sessionKey, options).row;
}

export function buildGatewaySessionInfo(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  readSource?: SessionEntryReadSource;
  key: string;
  entry?: SessionEntry;
  agentId: string;
  now?: number;
  modelCatalog?: ModelCatalogEntry[];
}): GatewaySessionRow {
  return buildGatewaySessionRow({
    cfg: params.cfg,
    storePath: params.storePath,
    store: params.store,
    modelSource: { entry: params.entry, loadSessionEntry: createGatewaySessionEntryReader(params) },
    key: params.key,
    entry: params.entry,
    agentId: params.agentId,
    modelCatalog: params.modelCatalog,
    now: params.now,
    skipTranscriptUsageFallback: true,
    lightweightListRow: true,
  });
}
