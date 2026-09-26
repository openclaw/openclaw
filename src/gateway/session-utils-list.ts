import { performance } from "node:perf_hooks";
import {
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import pMap from "p-map";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { isConfiguredGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import { canonicalSessionKeyMigrationRequiredError } from "../config/sessions/session-canonical-key.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { SESSIONS_LIST_OWNER_LIMIT } from "../shared/session-list-limits.js";
import { runSynchronousWork, type SynchronousWork } from "../shared/synchronous-work.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import { resolveGatewayModelSelectionPolicy } from "./server-methods/session-model-selection-policy.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { readPreparedGatewayModelCatalogMetadata } from "./server-model-catalog-view.js";
import type { SessionListDiagnostics } from "./session-list-diagnostics.types.js";
import {
  filterSessionCandidateEntries,
  filterSessionEntries,
  projectSessionListCandidateOptions,
  type SessionListFilteredEntries,
  type SessionListFilterParams,
} from "./session-list-filters.js";
import { sortAndLimitSessionEntries, type SessionEntryPair } from "./session-list-order.js";
import { bindSessionListRowRead } from "./session-list-read-result.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
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
  const limit = resolveOptionalIntegerOption(params.opts.limit, { min: 1 }) ?? params.defaultLimit;
  const offset = resolveNonNegativeIntegerOption(params.opts.offset, 0);
  const windowLimit = resolveSessionsListWindowLimit(limit, offset);
  const sortedWindow = params.entriesSorted
    ? filtered.slice(0, windowLimit)
    : yield* sortAndLimitSessionEntries(
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
    const ownerLimit = Math.min(limit ?? SESSIONS_LIST_OWNER_LIMIT, SESSIONS_LIST_OWNER_LIMIT);
    const owned = params.entriesSorted
      ? ownerEntries.slice(0, ownerLimit)
      : yield* sortAndLimitSessionEntries(
          ownerEntries,
          ownerLimit,
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
  policyConfig: OpenClawConfig,
  client?: GatewayClient | null,
): SessionsListResult {
  const { cfg, opts, modelCatalog } = params;
  // The defaults projection uses the same agent identity as getSessionDefaults:
  // the requested agent when scoped, otherwise the legacy compatibility agent.
  // Legacy plain-array catalogs (direct list callers) pass through
  // unchanged; per-agent maps resolve by the same identity.
  const defaultsAgentId = resolveSessionsListDefaultsAgentId(cfg, opts.agentId);
  const preparedDefaultsCatalog =
    modelCatalog instanceof Map ? modelCatalog.get(defaultsAgentId) : undefined;
  const defaultsCatalog =
    modelCatalog instanceof Map ? preparedDefaultsCatalog?.entries : modelCatalog;
  const metadataSnapshot = readPreparedGatewayModelCatalogMetadata(preparedDefaultsCatalog);
  const defaults = getSessionDefaults(cfg, defaultsCatalog, {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    allowPluginNormalization: false,
    providerPolicySource: preparedDefaultsCatalog?.pluginRegistry,
    metadataSnapshot,
  });
  const policy =
    client === undefined
      ? undefined
      : prepareOperatorModelPresentation({ cfg, policyConfig, client, metadataSnapshot })?.forAgent(
          defaultsAgentId,
          defaultsCatalog,
        );
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
    defaults: policy ? policy.defaults(defaults) : defaults,
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
type SelectionTarget = Pick<
  RecordRow,
  "key" | "agentId" | "storeTarget" | "entry" | "selection" | "hasBoard" | "generation"
>;
const sentinel = (key: string) => key === "global" || key === "unknown";

type SessionRowSelection = {
  winners: Map<string, SelectionTarget>;
  entries: SessionEntryPair[];
};

// Only metadata changes release selections; never retain replaceable materialized row graphs.
// Retain broad selections per topology scope; keyed reads never displace them.
const sessionRowSelections = new WeakMap<
  SessionRowProjection["state"]["revision"],
  WeakMap<ReturnType<SessionRowProjection["state"]["scope"]>, Map<boolean, SessionRowSelection>>
>();

/** Preserve federation before caller visibility and activity filters. */
export function prepareSessionRowSelection(
  projection: SessionRowProjection,
  opts: SessionsListParams,
  prepared?: Pick<SessionRowQuery, "key" | "sessionIdOrKey"> & {
    now?: number;
    rowContext?: SessionListRowContext;
  },
) {
  const { cfg, modelCatalog, scope, revision, rowContext: residentContext } = projection.state;
  const selectedScope = scope(opts);
  const now = prepared?.now ?? Date.now();
  const rowContext = prepared?.rowContext ?? {
    ...residentContext,
    subagentRuns: residentContext.subagentRuns.atTime(now),
  };
  const keyed = prepared?.key !== undefined || prepared?.sessionIdOrKey !== undefined;
  const activeOnly = opts.activeOnly === true;
  let selection = keyed
    ? undefined
    : sessionRowSelections.get(revision)?.get(selectedScope)?.get(activeOnly);
  if (!selection) {
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
    selection = {
      winners: new Map(
        [...winners].map(([key, row]) => [
          key,
          {
            key: row.key,
            agentId: row.agentId,
            storeTarget: row.storeTarget,
            entry: row.entry,
            selection: row.selection,
            hasBoard: row.hasBoard,
            generation: row.generation,
          },
        ]),
      ),
      entries,
    };
    if (!keyed) {
      const currentRevision = projection.state.revision;
      let scopes = sessionRowSelections.get(currentRevision);
      if (!scopes) {
        scopes = new WeakMap();
        sessionRowSelections.set(currentRevision, scopes);
      }
      let variants = scopes.get(selectedScope);
      if (!variants) {
        variants = new Map();
        scopes.set(selectedScope, variants);
      }
      variants.set(activeOnly, selection);
    }
  }
  const { winners, entries } = selection;
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
      | (SelectionTarget & {
          storeKey?: string;
          getModelFacts?: () => ReturnType<SessionRowProjection["modelFacts"]>;
        })
      | undefined => {
      const winner = winners.get(key);
      if (!winner || (!opts.search && key === winner.key)) {
        return winner;
      }
      const query = {
        agentId: winner.agentId,
        key: winner.key,
        storePath: winner.storeTarget.storePath,
      };
      return {
        ...winner,
        ...(opts.search ? { materialized: projection.capture(query)?.materialized } : {}),
        ...(key !== winner.key ? { storeKey: winner.key } : {}),
        getModelFacts: () => projection.modelFacts(query),
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

/** Acquire mutable workspace names before entering synchronous visibility and selection. */
export async function prepareSessionSearchIdentityNames(
  projection: SessionRowProjection,
  opts: SessionsListParams,
) {
  const prepared = prepareSessionRowSelection(projection, opts);
  const scope = projection.state.scope(opts);
  const agentIds = new Set(scope.agentId ? [scope.agentId] : listAgentIds(prepared.cfg));
  for (const [key] of prepared.entries) {
    const agentId = prepared.getTarget(key)?.agentId;
    if (agentId) {
      agentIds.add(agentId);
    }
  }
  const identities = await pMap(
    [...agentIds],
    (agentId) => resolveAssistantIdentity({ cfg: prepared.cfg, agentId }),
    { concurrency: 4 },
  );
  return {
    cfg: prepared.cfg,
    names: new Map(identities.map(({ agentId, name }) => [agentId, name])),
  };
}

// One filter set per resident owner; never retain viewer decisions or time-dependent predicates.
const sessionListCandidates = new WeakMap<
  SessionEntryPair[],
  { key: string; entries: SessionEntryPair[] }
>();

/** Shared synchronous membership policy for list pages and full-roster transcript search. */
export function prepareProjectedSessionList(params: {
  projection: SessionRowProjection;
  opts: SessionsListParams;
  key?: string;
  context?: GatewayRequestContext;
  client?: GatewayClient | null;
  now: number;
  searchIdentities?: Awaited<ReturnType<typeof prepareSessionSearchIdentityNames>>;
}) {
  const { projection, opts, key: exactKey, context, client, now } = params;
  if (params.searchIdentities && params.searchIdentities.cfg !== projection.state.cfg) {
    throw new Error("Session identity configuration changed while reading; retry the request");
  }
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
    key: exactKey,
    now,
    rowContext: presentation.rowContext,
  });
  const { getTarget } = prepared;
  const { active } = presentation;
  const identity = gatewayClientSessionCreator(client ?? null)?.id;
  let candidates: SessionEntryPair[] | undefined;
  // Person references resolve against the full visible roster before candidate filtering.
  if (!opts.spawnedBy && !opts.involvingProfileId) {
    const candidateOptions = projectSessionListCandidateOptions(opts);
    const key = JSON.stringify([exactKey, candidateOptions, opts.sortBy]);
    let cached = sessionListCandidates.get(prepared.entries);
    if (cached?.key !== key) {
      cached = {
        key,
        entries: runSynchronousWork(
          sortAndLimitSessionEntries(
            runSynchronousWork(
              filterSessionCandidateEntries({ ...prepared, opts: candidateOptions }),
            ),
            undefined,
            opts.sortBy,
          ),
        ),
      };
      sessionListCandidates.set(prepared.entries, cached);
    }
    candidates = cached.entries;
  }
  const filters: SessionListFilterParams = {
    ...prepared,
    identityNames: params.searchIdentities?.names,
    ...(candidates ? { entries: candidates, candidatesPrepared: true, entriesSorted: true } : {}),
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

/** Prepare selected rows, then authorize and present them in one synchronous boundary. */
export async function listProjectedSessions(params: {
  projection: SessionRowProjection;
  opts: SessionsListParams;
  key?: string;
  context?: GatewayRequestContext;
  client?: GatewayClient | null;
  diagnostics?: SessionListDiagnostics;
  onResult?: (result: SessionsListResult) => void;
}): Promise<SessionsListResult> {
  const { projection, opts, key: exactKey, context, client, diagnostics } = params;
  const dirtyRowCount = projection.dirtyRowCount;
  const materializedBefore = projection.materializedCount;
  diagnostics?.mark("materialize");
  const waitStarted = performance.now();
  let yieldCount = 0;
  let searchIdentities: Awaited<ReturnType<typeof prepareSessionSearchIdentityNames>> | undefined;
  do {
    yieldCount++;
    await projection.ensureMaterialized();
    if (opts.search?.trim()) {
      searchIdentities = await prepareSessionSearchIdentityNames(projection, opts);
    }
  } while (
    projection.needsMaterialization ||
    (searchIdentities && searchIdentities.cfg !== projection.state.cfg)
  );
  let prepareSyncMs = 0;
  const selectPage = () => {
    const started = performance.now();
    const syncCpu = diagnostics?.startSyncCpu();
    try {
      diagnostics?.mark("storeLoad");
      const now = Date.now();
      const { presentation, prepared, filters } = prepareProjectedSessionList({
        projection,
        opts,
        key: exactKey,
        context,
        client,
        now,
        searchIdentities,
      });
      diagnostics?.mark("filterSetup");
      const selection = withAgentRosterFactsBatch(prepared.cfg, () =>
        runSynchronousWork(selectSessionEntries({ ...filters, defaultLimit: 100 })),
      );
      return { now, presentation, prepared, selection };
    } finally {
      diagnostics?.finishSyncCpu("prepareThreadCpuMs", syncCpu);
      prepareSyncMs += performance.now() - started;
      if (diagnostics) {
        diagnostics.projection.prepareSyncMs = prepareSyncMs;
      }
      diagnostics?.mark("materialize");
    }
  };
  let page: ReturnType<typeof selectPage>;
  return withReadySessionRows(
    projection,
    () => {
      page = selectPage();
      return page.selection.entries.flatMap(([key]) => {
        const target = page.prepared.getTarget(key);
        return target
          ? [{ agentId: target.agentId, key: target.key, storePath: target.storeTarget.storePath }]
          : [];
      });
    },
    () => {
      const resumed = performance.now();
      const { now, presentation, prepared, selection } = page;
      const { cfg, getTarget } = prepared;
      diagnostics?.mark("sharing");
      diagnostics?.mark("rows");
      const rowsStarted = performance.now();
      let syncCpu = diagnostics?.startSyncCpu();
      try {
        let materializedRowCount = 0;
        projection.setArchivePageSize(selection.entries.length);
        const sessions = selection.entries.flatMap(([key], index) => {
          const target = getTarget(key);
          const record =
            target &&
            projection.describe({
              agentId: target.agentId,
              key: target.key,
              storePath: target.storeTarget.storePath,
            });
          if (!record) {
            return [];
          }
          const includeTranscriptFields = index < 100 + selection.ownerCount;
          const row = presentation.present(record, {
            includeDerivedTitles: opts.includeDerivedTitles && includeTranscriptFields,
            includeLastMessage: opts.includeLastMessage && includeTranscriptFields,
            includeActivitySummary: opts.includeActivitySummary === true,
          });
          if (!row) {
            return [];
          }
          bindSessionListRowRead(row, { projection, record, client });
          if ((record.materializedSequence ?? 0) > materializedBefore) {
            materializedRowCount++;
          }
          if (opts.activeOnly && sentinel(record.key)) {
            row.childSessions = undefined;
            row.hasActiveSubagentRun = undefined;
          }
          return [row];
        });
        diagnostics?.mark("decoration");
        const result = buildSessionsListResult(
          prepared,
          { ...selection, now, storePath: prepared.storePath },
          sessions,
          context?.getCommittedRuntimeConfig?.() ?? cfg,
          client,
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
            prepareSyncMs,
            rowSyncMs: performance.now() - rowsStarted,
            yieldWaitMs: resumed - waitStarted - prepareSyncMs,
            yieldCount,
            selectedRowCount: sessions.length,
            dirtyRowCount,
            materializedRowCount,
            reusedRowCount: sessions.length - materializedRowCount,
          });
        }
        diagnostics?.finishSyncCpu("rowThreadCpuMs", syncCpu);
        syncCpu = undefined;
        params.onResult?.(result);
        return result;
      } finally {
        diagnostics?.finishSyncCpu("rowThreadCpuMs", syncCpu);
      }
    },
  );
}
