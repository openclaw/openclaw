import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { SessionEntry } from "../config/sessions.js";
import type { GatewayStoredSessionTargets } from "../config/sessions/combined-store-gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPinnedActivePluginRegistryWorkspaceDir } from "../plugins/runtime-workspace-state.js";
import {
  isIncognitoSessionKey,
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
} from "../routing/session-key.js";
import { SESSIONS_LIST_OWNER_LIMIT } from "../shared/session-list-limits.js";
import { runSynchronousWork, type SynchronousWork } from "../shared/synchronous-work.js";
import { readPreparedGatewayModelCatalogMetadata } from "./server-model-catalog-view.js";
import { projectActivitySummaryList } from "./session-activity-summary-list.js";
import {
  filterSessionEntries,
  type SessionListFilteredEntries,
  type SessionListFilterParams,
} from "./session-list-filters.js";
import { sortAndLimitSessionEntries } from "./session-list-order.js";
import { readSessionTitleFieldsFromTranscriptBatch as readScopedSessionTitleFieldsFromTranscriptBatch } from "./session-transcript-title-reader.js";
import type {
  SessionActorProfileIdentity,
  SessionListActiveRunProjector,
  SessionListRowContext,
  SessionListRowContextProvider,
} from "./session-utils-contracts.js";
import { deriveSessionTitle, buildStoreChildSessionIndexWork } from "./session-utils-core.js";
import { getSessionDefaults } from "./session-utils-model.js";
import {
  buildSessionListRowMetadataContext,
  populateSessionListAcpMetadataWork,
} from "./session-utils-projection.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";
import type {
  GatewaySessionRow,
  SessionListModelCatalog,
  SessionsListResult,
} from "./session-utils.types.js";

// Bound synchronous projection work without repeatedly requeueing cheap prepared rows.
const SESSIONS_LIST_YIELD_INTERVAL_MS = 12;

const SESSIONS_LIST_DEFAULT_LIMIT = 100;
const SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS = 100;

export type SessionListProjectionTiming = {
  prepareSyncMs: number;
  rowSyncMs: number;
  yieldWaitMs: number;
  yieldCount: number;
};

type SessionSelectionScope =
  | { opts: SessionsListParams; targetsBySessionKey: GatewayStoredSessionTargets }
  | {
      opts: Omit<SessionsListParams, "search"> & { search?: never };
      targetsBySessionKey?: never;
    };

type ListSessionsFromStoreParams = {
  cfg: OpenClawConfig;
  durableStorePath?: string;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
  storePath: string;
  store: Record<string, SessionEntry>;
  // Sentinels retain the first projected store's owner; their raw key cannot recover it.
  targetsBySessionKey: GatewayStoredSessionTargets;
  modelCatalog?: SessionListModelCatalog | ModelCatalogEntry[];
  opts: SessionsListParams;
  involvingActorId?: string;
  ownerFirstActorId?: string;
  projectActiveRun?: SessionListActiveRunProjector;
};

type SessionEntrySelection = Omit<SessionListFilteredEntries, "ownerEntries"> & {
  ownerCount: number;
  totalCount: number;
  limitApplied?: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
};

function resolveSessionsListLimit(
  opts: SessionsListParams,
  defaultLimit?: number,
): number | undefined {
  if (typeof opts.limit !== "number" || !Number.isFinite(opts.limit)) {
    return defaultLimit;
  }
  return Math.max(1, Math.floor(opts.limit));
}

function resolveSessionsListOffset(opts: SessionsListParams): number {
  if (typeof opts.offset !== "number" || !Number.isFinite(opts.offset)) {
    return 0;
  }
  return Math.max(0, Math.floor(opts.offset));
}

function resolveSessionsListWindowLimit(limit: number | undefined, offset: number) {
  if (limit === undefined) {
    return undefined;
  }
  const windowLimit = offset + limit;
  return Number.isFinite(windowLimit) ? Math.min(windowLimit, Number.MAX_SAFE_INTEGER) : undefined;
}

function* selectSessionEntries(
  params: SessionListFilterParams & { defaultLimit?: number },
): SynchronousWork<SessionEntrySelection> {
  const { ownerEntries, entries: filtered, ...facets } = yield* filterSessionEntries(params);
  const limit = resolveSessionsListLimit(params.opts, params.defaultLimit);
  const offset = resolveSessionsListOffset(params.opts);
  const windowLimit = resolveSessionsListWindowLimit(limit, offset);
  const sortedWindow = yield* sortAndLimitSessionEntries(
    filtered,
    windowLimit,
    params.opts.sortBy,
    params.shouldYield,
  );
  const sharedEntries =
    limit === undefined ? sortedWindow.slice(offset) : sortedWindow.slice(offset, offset + limit);
  let entries = sharedEntries;
  let ownerCount = 0;
  if (params.ownerFirstActorId && offset === 0) {
    const owned = yield* sortAndLimitSessionEntries(
      ownerEntries,
      Math.min(limit ?? SESSIONS_LIST_OWNER_LIMIT, SESSIONS_LIST_OWNER_LIMIT),
      params.opts.sortBy,
      params.shouldYield,
    );
    ownerCount = owned.length;
    const ownedKeys = new Set(owned.map(([key]) => key));
    entries = [...owned, ...sharedEntries.filter(([key]) => !ownedKeys.has(key))];
  }
  const nextOffset = offset + sharedEntries.length;
  const hasMore = nextOffset < filtered.length;
  return {
    ...facets,
    entries,
    ownerCount,
    totalCount: filtered.length,
    limitApplied: limit,
    offset,
    nextOffset: hasMore ? nextOffset : null,
    hasMore,
  };
}

function* prepareSessionList(params: ListSessionsFromStoreParams, shouldYield: () => boolean) {
  const { cfg, store, opts } = params;
  const now = Date.now();
  const userProfileIdentityById = new Map<string, SessionActorProfileIdentity | undefined>();
  const configuredAgentIds = new Set(listAgentIds(cfg));
  let rowContext: SessionListRowContext | undefined;
  const getRowContext = () =>
    (rowContext ??= buildSessionListRowMetadataContext({ now, userProfileIdentityById }));
  const hasSpawnedByFilter = typeof opts.spawnedBy === "string" && opts.spawnedBy.length > 0;
  const filteredSessionKeys = new Set<string>();
  let hasIncognito = false;
  const entryFilter = (key: string, entry: SessionEntry) => {
    if (params.entryFilter && !params.entryFilter(key, entry)) {
      filteredSessionKeys.add(key);
      return false;
    }
    hasIncognito ||= entry.incognito === true || isIncognitoSessionKey(key);
    return true;
  };
  const selection = yield* selectSessionEntries({
    cfg,
    modelCatalog: params.modelCatalog,
    store,
    targetsBySessionKey: params.targetsBySessionKey,
    opts,
    now,
    entryFilter,
    // This wrapper also tracks incognito for unrestricted callers; preserve the original scope.
    restrictProfileReferences: params.entryFilter !== undefined,
    defaultLimit: SESSIONS_LIST_DEFAULT_LIMIT,
    getRowContext:
      hasSpawnedByFilter || normalizeOptionalString(opts.search) ? getRowContext : undefined,
    userProfileIdentityById,
    configuredAgentIds,
    involvingActorId: params.involvingActorId,
    ownerFirstActorId: params.ownerFirstActorId,
    projectActiveRun: params.projectActiveRun,
    shouldYield,
  });
  // Filtering, child links, and row display share one registry snapshot per response.
  const sharedRowContext = selection.entries.length > 0 ? getRowContext() : undefined;
  const storePath = hasIncognito ? params.storePath : (params.durableStorePath ?? params.storePath);
  const storeChildSessionsByKey = yield* buildStoreChildSessionIndexWork(
    {
      store,
      keys: [
        ...new Set(
          selection.entries.map(([key]) => params.targetsBySessionKey.get(key)?.storeKey ?? key),
        ),
      ],
      now,
      subagentRuns: sharedRowContext?.subagentRuns,
      excludedChildKeys: filteredSessionKeys,
    },
    shouldYield,
  );
  yield* populateSessionListAcpMetadataWork({
    cfg,
    entries: selection.entries,
    targetsBySessionKey: params.targetsBySessionKey,
    rowContext: sharedRowContext,
  });
  return {
    ...selection,
    includeDerivedTitles: opts.includeDerivedTitles === true,
    includeLastMessage: opts.includeLastMessage === true,
    // The independent owner window must not consume the shared page's transcript budget.
    transcriptFieldRows: SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS + selection.ownerCount,
    now,
    configuredAgentIds,
    rowContext: sharedRowContext,
    storeChildSessionsByKey,
    storePath,
  };
}

function buildSessionsListResult(
  params: ListSessionsFromStoreParams,
  list: ReturnType<typeof prepareSessionList> extends SynchronousWork<infer T> ? T : never,
  sessions: GatewaySessionRow[],
): SessionsListResult {
  projectActivitySummaryList(params, sessions);
  const { cfg, opts, modelCatalog } = params;
  // The defaults projection uses the same agent identity as getSessionDefaults:
  // the requested agent when scoped, otherwise the legacy compatibility agent.
  // Legacy plain-array catalogs (direct list callers) pass through
  // unchanged; per-agent maps resolve by the same identity.
  const preparedDefaultsCatalog =
    modelCatalog instanceof Map
      ? modelCatalog.get(resolveSessionsListDefaultsAgentId(cfg, opts.agentId))
      : undefined;
  const defaultsCatalog =
    modelCatalog instanceof Map ? preparedDefaultsCatalog?.entries : modelCatalog;
  return {
    ts: list.now,
    path: list.storePath,
    count: sessions.length,
    totalCount: list.totalCount,
    limitApplied: list.limitApplied,
    offset: list.offset > 0 ? list.offset : undefined,
    nextOffset: list.nextOffset,
    hasMore: list.hasMore,
    owners: list.ownerFacet,
    involvingProfileId: list.involvingProfileId,
    ...(list.people
      ? {
          people: list.people,
          peopleIncomplete: list.peopleIncomplete,
          peopleSessionCount: list.peopleSessionCount,
        }
      : {}),
    defaults: getSessionDefaults(cfg, defaultsCatalog, {
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      allowPluginNormalization: false,
      providerPolicySource: preparedDefaultsCatalog?.pluginRegistry,
      metadataSnapshot: readPreparedGatewayModelCatalogMetadata(preparedDefaultsCatalog),
    }),
    sessions,
  };
}

function resolveSessionsListDefaultsAgentId(
  cfg: OpenClawConfig,
  requestedAgentId?: string,
): string {
  return requestedAgentId
    ? normalizeAgentId(requestedAgentId)
    : normalizeAgentId(tryResolveLegacyCompatibilityAgentId(cfg) ?? LEGACY_IMPLICIT_AGENT_ID);
}

export function filterAndSortSessionEntries(
  params: {
    cfg: OpenClawConfig;
    entryFilter?: (key: string, entry: SessionEntry) => boolean;
    store: Record<string, SessionEntry>;
    now: number;
    getRowContext?: SessionListRowContextProvider;
    involvingActorId?: string;
  } & SessionSelectionScope,
): [string, SessionEntry][] {
  return withAgentRosterFactsBatch(params.cfg, () =>
    runSynchronousWork(
      selectSessionEntries({
        ...params,
        restrictProfileReferences: params.entryFilter !== undefined,
      }),
    ),
  ).entries;
}

/** Projects lightweight list rows while sharing the event loop with other requests. */
export async function listSessionsFromStoreAsync(
  params: ListSessionsFromStoreParams & {
    workStartedAt?: number;
    projectionTiming?: SessionListProjectionTiming;
  },
): Promise<SessionsListResult> {
  // Pin the active plugin-registry workspace dir for the duration of this
  // call so per-row metadata lookups use a stable memo key. Without this pin,
  // concurrent agent turns / crons mutate the process-global workspace dir
  // between rows, the memo never hits, and each row triggers a full
  // loadPluginMetadataSnapshot scan (~100 ms).
  return withPinnedActivePluginRegistryWorkspaceDir(async () => {
    let workStartedAt = params.workStartedAt ?? performance.now();
    const timing = params.projectionTiming;
    let syncStartedAt = timing ? performance.now() : 0;
    let syncPhase: "prepareSyncMs" | "rowSyncMs" | undefined = "prepareSyncMs";
    const yieldIfNeeded = (): Promise<void> | undefined => {
      const checkpoint = performance.now();
      if (checkpoint - workStartedAt < SESSIONS_LIST_YIELD_INTERVAL_MS) {
        return undefined;
      }
      const phase = syncPhase;
      if (timing && phase) {
        timing[phase] += checkpoint - syncStartedAt;
      }
      syncPhase = undefined;
      return yieldToEventLoop().then(() => {
        workStartedAt = performance.now();
        if (timing) {
          timing.yieldWaitMs += workStartedAt - checkpoint;
          timing.yieldCount++;
          syncStartedAt = workStartedAt;
        }
        syncPhase = phase;
      });
    };
    try {
      const { cfg, store, targetsBySessionKey } = params;
      let checkedItems = 0;
      // Sample the clock in small batches, and leave nested generators only when work is due.
      const shouldYieldPreparation = () =>
        ++checkedItems % 16 === 0 &&
        performance.now() - workStartedAt >= SESSIONS_LIST_YIELD_INTERVAL_MS;
      const preparation = prepareSessionList(params, shouldYieldPreparation);
      // Each chunk shares roster facts, then releases them before another request can run.
      let step = withAgentRosterFactsBatch(cfg, () => preparation.next());
      while (!step.done) {
        const pause = yieldIfNeeded();
        if (pause) {
          await pause;
        }
        step = withAgentRosterFactsBatch(cfg, () => preparation.next());
      }
      const list = step.value;
      const sessions: GatewaySessionRow[] = [];
      const includeTranscriptFields = list.includeDerivedTitles || list.includeLastMessage;
      const transcriptScopes = list.entries
        .slice(0, list.transcriptFieldRows)
        .flatMap(([key, entry]) => {
          if (!entry.sessionId || !includeTranscriptFields) {
            return [];
          }
          const target = expectDefined(targetsBySessionKey.get(key), "transcript row target");
          return [
            {
              ...target.storeTarget,
              sessionEntry: entry,
              sessionId: entry.sessionId,
              sessionKey: target.storeKey ?? key,
            },
          ];
        });
      const transcriptFields = readScopedSessionTitleFieldsFromTranscriptBatch(transcriptScopes);
      // Optional transcript reads can spend the remaining budget even for an empty page.
      const checkpoint = performance.now();
      if (timing) {
        timing.prepareSyncMs += checkpoint - syncStartedAt;
        syncStartedAt = checkpoint;
        syncPhase = "rowSyncMs";
      }
      const preparationPause = yieldIfNeeded();
      if (preparationPause) {
        await preparationPause;
      }
      let transcriptFieldIndex = 0;
      for (let nextRowIndex = 0; nextRowIndex < list.entries.length;) {
        // Release roster facts before a pause so resumed rows observe current entries.
        const pause = withAgentRosterFactsBatch(cfg, () => {
          while (nextRowIndex < list.entries.length) {
            const i = nextRowIndex++;
            const [key, entry] = expectDefined(list.entries[i], "entries entry at i");
            const target = expectDefined(targetsBySessionKey.get(key), "session row owner");
            const row = buildGatewaySessionRow({
              cfg,
              storePath: target.storeTarget.storePath, // Aggregate paths are display-only.
              store,
              modelSource: target.modelSource,
              key: target.storeKey ?? key,
              entry,
              agentId: target.agentId,
              modelCatalog: params.modelCatalog,
              now: list.now,
              storeChildSessionsByKey: list.storeChildSessionsByKey,
              rowContext: list.rowContext,
              configuredAgentIds: list.configuredAgentIds,
              skipTranscriptUsageFallback: true,
              lightweightListRow: true,
            });
            row.key = key;
            if (entry?.sessionId && i < list.transcriptFieldRows && includeTranscriptFields) {
              const { firstUserMessage, lastMessagePreview } = expectDefined(
                transcriptFields[transcriptFieldIndex++],
                "batched transcript fields at transcriptFieldIndex",
              );
              if (list.includeDerivedTitles) {
                row.derivedTitle = deriveSessionTitle(entry, firstUserMessage, row.displayName);
              }
              if (list.includeLastMessage && lastMessagePreview) {
                row.lastMessagePreview = lastMessagePreview;
              }
            }
            sessions.push(row);
            const rowPause = nextRowIndex < list.entries.length ? yieldIfNeeded() : undefined;
            if (rowPause) {
              return rowPause;
            }
          }
          return undefined;
        });
        if (pause) {
          await pause;
        }
      }

      return buildSessionsListResult(params, list, sessions);
    } finally {
      if (timing && syncPhase) {
        timing[syncPhase] += performance.now() - syncStartedAt;
      }
    }
  });
}
