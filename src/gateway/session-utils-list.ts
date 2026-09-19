import { performance } from "node:perf_hooks";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { isConfiguredGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import { canonicalSessionKeyMigrationRequiredError } from "../config/sessions/session-canonical-key.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { SESSIONS_LIST_OWNER_LIMIT } from "../shared/session-list-limits.js";
import { runSynchronousWork, type SynchronousWork } from "../shared/synchronous-work.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import { resolveGatewayModelSelectionPolicy } from "./server-methods/session-model-selection-policy.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { readPreparedGatewayModelCatalogMetadata } from "./server-model-catalog-view.js";
import type { SessionListDiagnostics } from "./session-list-diagnostics.types.js";
import {
  filterSessionEntries,
  type SessionListFilteredEntries,
  type SessionListFilterParams,
} from "./session-list-filters.js";
import { sortAndLimitSessionEntries, type SessionEntryPair } from "./session-list-order.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import type { Query as SessionRowQuery } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { getSessionDefaults } from "./session-utils-model.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";

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

function buildSessionsListResult(
  params: Pick<SessionListFilterParams, "cfg" | "opts" | "modelCatalog">,
  list: SessionEntrySelection & { now: number; storePath: string },
  sessions: GatewaySessionRow[],
): SessionsListResult {
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

type RecordRow = ReturnType<SessionRowProjection["selectEntries"]>[number];
const sentinel = (key: string) => key === "global" || key === "unknown";

/** Preserve federation before caller visibility and activity filters. */
export function prepareSessionRowSelection(
  projection: SessionRowProjection,
  opts: SessionsListParams,
  prepared?: Pick<SessionRowQuery, "key" | "sessionIdOrKey"> & {
    now?: number;
    rowContext?: SessionListRowContext;
  },
) {
  const { cfg, modelCatalog, scope, rowContext: residentContext } = projection.state;
  const selectedScope = scope(opts);
  const now = prepared?.now ?? Date.now();
  const rowContext = prepared?.rowContext ?? {
    ...residentContext,
    subagentRuns: residentContext.subagentRuns.atTime(now),
  };
  const rows = projection
    .selectEntries({
      agentId: selectedScope.agentId,
      key: prepared?.key,
      sessionIdOrKey: prepared?.sessionIdOrKey,
      sortBy: null,
    })
    .filter(
      (row) =>
        selectedScope.paths.has(row.storeTarget.storePath) &&
        (!selectedScope.configuredAgentIds ||
          isConfiguredGatewaySessionEntry(
            cfg,
            selectedScope.configuredAgentIds,
            row.key,
            row.entry,
          )),
    );
  const winners = new Map<string, RecordRow>();
  const keyFor = (row: RecordRow) =>
    sentinel(row.key) && opts.activeOnly ? JSON.stringify([row.key, row.agentId]) : row.key;
  for (const row of rows) {
    const key = keyFor(row);
    const previous = winners.get(key);
    if (previous && !sentinel(row.key)) {
      throw canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${row.key}`,
      );
    }
    // Equal precedence retains the first resident row, as a stable sort would.
    if (
      !previous ||
      selectedScope.paths.get(row.storeTarget.storePath)! <
        selectedScope.paths.get(previous.storeTarget.storePath)!
    ) {
      winners.set(key, row);
    }
  }
  const entries: SessionEntryPair[] = [];
  for (const row of rows) {
    const key = keyFor(row);
    if (winners.get(key) === row) {
      entries.push([key, row.entry]);
    }
  }
  return {
    cfg,
    opts,
    now,
    modelCatalog,
    entries,
    storePath: selectedScope.path,
    userProfileIdentityById: rowContext.userProfileIdentityById,
    getRowContext: () => rowContext,
    getTarget: (
      key: string,
    ):
      | (RecordRow & {
          storeKey?: string;
          getModelFacts?: () => ReturnType<SessionRowProjection["modelFacts"]>;
        })
      | undefined => {
      const winner = winners.get(key);
      if (!winner || (!opts.search && key === winner.key)) {
        return winner;
      }
      return {
        ...winner,
        ...(key !== winner.key ? { storeKey: winner.key } : {}),
        getModelFacts: () => projection.modelFacts(winner),
      };
    },
  };
}

export function filterAndSortSessionEntries(params: SessionListFilterParams): SessionEntryPair[] {
  return withAgentRosterFactsBatch(params.cfg, () =>
    runSynchronousWork(
      selectSessionEntries({
        ...params,
        restrictProfileReferences: params.entryFilter !== undefined,
      }),
    ),
  ).entries;
}

/** Shared synchronous membership policy for list pages and full-roster transcript search. */
export function prepareProjectedSessionList(params: {
  projection: SessionRowProjection;
  opts: SessionsListParams;
  context?: GatewayRequestContext;
  client?: GatewayClient | null;
  now: number;
}) {
  const { projection, opts, context, client, now } = params;
  const presentation = prepareProjectedSessionPresentation(
    projection,
    client,
    now,
    context
      ? createVisibleActiveSessionRunProjector(
          context,
          projection.state.rowContext.projectedAgentRuns,
        )
      : undefined,
  );
  const prepared = prepareSessionRowSelection(projection, opts, {
    now,
    rowContext: presentation.rowContext,
  });
  const { getTarget } = prepared;
  const { active } = presentation;
  const identity = gatewayClientSessionCreator(client ?? null)?.id;
  const filters: SessionListFilterParams = {
    ...prepared,
    involvingActorId: opts.involvingMe ? identity : undefined,
    ownerFirstActorId: opts.ownerFirst ? identity : undefined,
    restrictProfileReferences: client !== undefined,
    projectActiveRun: context
      ? (key, entry, agentId) => active(getTarget(key)?.key ?? key, entry, agentId)!
      : undefined,
    entryFilter: (key, entry) => {
      const row = getTarget(key);
      const visible = Boolean(
        row &&
        (client === undefined || (presentation.sharing.entryFilter?.(row.key, entry) ?? true)),
      );
      return (
        visible &&
        (opts.hasBoard === undefined || row?.hasBoard === opts.hasBoard) &&
        (!opts.activeOnly || Boolean(row && active(row.key, entry, row.agentId)?.active))
      );
    },
  };
  return { prepared, presentation, filters };
}

/** One readiness await, then one synchronous selection/authorization/presentation boundary. */
export async function listProjectedSessions(params: {
  projection: SessionRowProjection;
  opts: SessionsListParams;
  context?: GatewayRequestContext;
  client?: GatewayClient | null;
  diagnostics?: SessionListDiagnostics;
  onResult?: (result: SessionsListResult) => void;
}): Promise<SessionsListResult> {
  const { projection, opts, context, client, diagnostics } = params;
  const dirtyRowCount = projection.dirtyRowCount;
  const materializedBefore = projection.materializedCount;
  diagnostics?.mark("materialize");
  const waitStarted = performance.now();
  let yieldCount = 0;
  do {
    yieldCount++;
    await projection.ensureMaterialized();
  } while (projection.needsMaterialization);
  const resumed = performance.now();
  const now = Date.now();
  let cpuPhase: "prepareThreadCpuMs" | "rowThreadCpuMs" = "prepareThreadCpuMs";
  let syncCpu = diagnostics?.startSyncCpu();
  try {
    diagnostics?.mark("storeLoad");
    const { presentation, prepared, filters } = prepareProjectedSessionList({
      projection,
      opts,
      context,
      client,
      now,
    });
    const { cfg, getTarget } = prepared;
    diagnostics?.mark("filterSetup");
    const selection = withAgentRosterFactsBatch(cfg, () =>
      runSynchronousWork(
        selectSessionEntries({
          ...filters,
          defaultLimit: 100,
        }),
      ),
    );
    diagnostics?.mark("sharing");
    diagnostics?.mark("rows");
    const rowsStarted = performance.now();
    diagnostics?.finishSyncCpu(cpuPhase, syncCpu);
    syncCpu = undefined;
    cpuPhase = "rowThreadCpuMs";
    syncCpu = diagnostics?.startSyncCpu();
    let materializedRowCount = 0;
    projection.setArchivePageSize(selection.entries.length);
    const sessions = selection.entries.flatMap(([key], index) => {
      const target = getTarget(key);
      const record =
        target && projection.describe({ ...target, storePath: target.storeTarget.storePath });
      if (!record) {
        return [];
      }
      const includeTranscriptFields = index < 100 + selection.ownerCount;
      const row = presentation.present(record, {
        includeDerivedTitles: opts.includeDerivedTitles && includeTranscriptFields,
        includeLastMessage: opts.includeLastMessage && includeTranscriptFields,
      });
      if (!row) {
        return [];
      }
      if (!opts.includeActivitySummary) {
        delete row.activitySummary;
      }
      if ((record.materializedSequence ?? 0) > materializedBefore) {
        materializedRowCount++;
      }
      if (opts.activeOnly && sentinel(record.key)) {
        delete row.childSessions;
        delete row.hasActiveSubagentRun;
      }
      return [row];
    });
    diagnostics?.mark("decoration");
    const result = buildSessionsListResult(
      prepared,
      { ...selection, now, storePath: prepared.storePath },
      sessions,
    );
    if (client !== undefined) {
      result.defaults.modelSelectionTarget = resolveGatewayModelSelectionPolicy({
        callerScopes: client?.connect?.scopes ?? [],
        cfg,
      }).target;
    }
    diagnostics?.mark("visibilityRepair");
    if (diagnostics) {
      Object.assign(diagnostics.projection, {
        prepareSyncMs: rowsStarted - resumed,
        rowSyncMs: performance.now() - rowsStarted,
        yieldWaitMs: resumed - waitStarted,
        yieldCount,
        selectedRowCount: sessions.length,
        dirtyRowCount,
        materializedRowCount,
        reusedRowCount: sessions.length - materializedRowCount,
      });
    }
    diagnostics?.finishSyncCpu(cpuPhase, syncCpu);
    syncCpu = undefined;
    params.onResult?.(result);
    return result;
  } finally {
    diagnostics?.finishSyncCpu(cpuPhase, syncCpu);
  }
}
