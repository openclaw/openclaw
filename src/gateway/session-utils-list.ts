import { performance } from "node:perf_hooks";
import {
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import pMap from "p-map";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordSessionRowPartitionCache } from "../infra/gateway-work-metrics.js";
import { getMainThreadTaskName } from "../infra/main-thread-stall.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import {
  SESSIONS_LIST_OWNER_LIMIT,
  SESSIONS_LIST_TRANSCRIPT_LIMIT,
} from "../shared/session-list-limits.js";
import { resolveAssistantIdentityName } from "./assistant-identity.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import { resolveGatewayModelSelectionPolicy } from "./server-methods/session-model-selection-policy.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { readPreparedGatewayModelMetadata } from "./server-model-catalog-view.js";
import {
  addSessionOwnerFacetIdentity,
  sortSessionOwnerFacet,
} from "./session-identity-projection.js";
import { getSessionListBaseMiss, retainSessionListBaseMiss } from "./session-list-diagnostics.js";
import type { SessionListDiagnostics } from "./session-list-diagnostics.types.js";
import {
  filterSessionEntries,
  projectSessionOwnerRunningCounts,
  type SessionEntrySelection,
  type SessionListFilterParams,
  type SessionListFilteredEntries,
} from "./session-list-filters.js";
import { sortAndLimitSessionEntries, type SessionEntryPair } from "./session-list-order.js";
import { bindSessionListRowRead } from "./session-list-read-result.js";
import type { SessionRowGeneration } from "./session-row-identity.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import {
  prepareSessionRowPublication,
  shareSidebarSessionRows,
} from "./session-row-presentation.js";
import {
  selectionRow,
  type Lookup,
  type Query as SessionRowQuery,
  type SelectionRow as SelectionTarget,
} from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { createSessionRowSelection } from "./session-row-selection.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { matchesSessionArchiveFilter } from "./session-utils-core.js";
import { getSessionDefaults } from "./session-utils-model.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";

export function selectSessionEntries(
  params: SessionListFilterParams & {
    defaultLimit?: number;
    partitions?: ReturnType<ReturnType<typeof createSessionRowSelection>["read"]>["partitions"];
    retained?: WeakMap<object, SessionListFilteredEntries>;
  },
): SessionEntrySelection {
  const limit = resolveOptionalIntegerOption(params.opts.limit, { min: 1 }) ?? params.defaultLimit;
  const offset = resolveNonNegativeIntegerOption(params.opts.offset, 0);
  const ownerLimit =
    params.ownerFirstActorId && offset === 0
      ? Math.min(limit ?? SESSIONS_LIST_OWNER_LIMIT, SESSIONS_LIST_OWNER_LIMIT)
      : 0;
  // Person-reference resolution and people truncation require the whole visible roster.
  // Temporal queries are not retained by the presentation owner.
  const incremental =
    params.partitions &&
    params.retained &&
    !params.opts.includePeople &&
    !params.opts.involvingProfileId &&
    !params.opts.includeOwnerSessionCounts;
  let filteredResult: SessionListFilteredEntries;
  if (incremental) {
    const entries: SessionEntryPair[] = [];
    const ownerEntries: SessionEntryPair[] = [];
    const owners = new Map<string, SessionListFilteredEntries["ownerFacet"][number]>();
    let totalCount = 0;
    let hits = 0;
    let misses = 0;
    let activityExpiresAt = Infinity;
    const pageEnd =
      limit === undefined ? undefined : Math.min(offset + limit, Number.MAX_SAFE_INTEGER);
    for (const partition of params.partitions!) {
      if (!partition.entries.size) {
        continue;
      }
      let part = params.retained!.get(partition.revision);
      if (!part) {
        misses++;
        part = filterSessionEntries({
          ...params,
          entries: (archived) =>
            Array.from(partition.entries.values()).filter(([, entry]) =>
              matchesSessionArchiveFilter(entry, archived),
            ),
        });
        part.entries = sortAndLimitSessionEntries(part.entries, pageEnd, params.opts.sortBy);
        part.ownerEntries = sortAndLimitSessionEntries(
          part.ownerEntries,
          ownerLimit,
          params.opts.sortBy,
        );
        params.retained!.set(partition.revision, part);
      } else {
        hits++;
      }
      entries.push(...part.entries);
      ownerEntries.push(...part.ownerEntries);
      totalCount += part.totalCount;
      activityExpiresAt = Math.min(activityExpiresAt, part.activityExpiresAt ?? Infinity);
      for (const owner of part.ownerFacet) {
        addSessionOwnerFacetIdentity(owners, owner);
      }
    }
    recordSessionRowPartitionCache(hits, misses, getMainThreadTaskName());
    filteredResult = {
      entries,
      ownerEntries,
      totalCount,
      ownerFacet: sortSessionOwnerFacet(owners),
      ...(Number.isFinite(activityExpiresAt) ? { activityExpiresAt } : {}),
    };
  } else {
    filteredResult = filterSessionEntries(
      params,
      params.entriesSorted ? { offset, limit, ownerLimit } : undefined,
    );
  }
  const { ownerEntries, entries: filtered, ...facets } = filteredResult;
  const sharedEntries =
    params.entriesSorted && !incremental
      ? filtered
      : sortAndLimitSessionEntries(
          filtered,
          limit === undefined ? undefined : Math.min(offset + limit, Number.MAX_SAFE_INTEGER),
          params.opts.sortBy,
        ).slice(offset);
  let entries = sharedEntries;
  let ownerCount = 0;
  if (ownerLimit > 0) {
    const owned =
      params.entriesSorted && !incremental
        ? ownerEntries
        : sortAndLimitSessionEntries(ownerEntries, ownerLimit, params.opts.sortBy);
    ownerCount = owned.length;
    const ownedKeys = new Set(owned.map(([key]) => key));
    entries = [...owned, ...sharedEntries.filter(([key]) => !ownedKeys.has(key))];
  }
  const nextOffset = offset + sharedEntries.length;
  const hasMore = nextOffset < facets.totalCount;
  return {
    ...facets,
    entries,
    ownerCount,
    limitApplied: limit,
    offset,
    nextOffset: hasMore ? nextOffset : null,
    hasMore,
  };
}

function buildSessionsListResult(
  params: Pick<SessionListFilterParams, "cfg" | "opts" | "modelCatalog">,
  list: SessionEntrySelection & { now: number; storePath: string },
  { sessions, rowHistory }: { sessions: GatewaySessionRow[]; rowHistory?: SessionRowGeneration[] },
  policyConfig: OpenClawConfig,
  client?: GatewayClient | null,
): SessionsListResult {
  const { cfg, opts, modelCatalog } = params;
  // The defaults projection uses the same agent identity as getSessionDefaults:
  // the requested agent when scoped, otherwise the legacy compatibility agent.
  // Legacy plain-array catalogs (direct list callers) pass through
  // unchanged; per-agent maps resolve by the same identity.
  const defaultsAgentId = normalizeAgentId(
    opts.agentId || (tryResolveLegacyCompatibilityAgentId(cfg) ?? LEGACY_IMPLICIT_AGENT_ID),
  );
  const preparedDefaultsCatalog =
    modelCatalog instanceof Map ? modelCatalog.get(defaultsAgentId) : undefined;
  const defaultsCatalog =
    modelCatalog instanceof Map ? preparedDefaultsCatalog?.entries : modelCatalog;
  const metadataSnapshot = readPreparedGatewayModelMetadata(cfg, preparedDefaultsCatalog);
  const defaults = getSessionDefaults(cfg, defaultsCatalog, {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    allowPluginNormalization: false,
    providerPolicySource: preparedDefaultsCatalog?.pluginRegistry ?? "active",
    metadataSnapshot,
  });
  const policy =
    client === undefined
      ? undefined
      : prepareOperatorModelPresentation({
          cfg,
          policyConfig,
          client,
          metadataSnapshot,
        })?.forAgent(defaultsAgentId, defaultsCatalog);
  const sharedRows =
    opts.rowMode === "sidebar" || opts.ifRowsRevision !== undefined
      ? shareSidebarSessionRows(sessions, opts.ifRowsRevision, rowHistory)
      : { sessions };
  const result = {
    ts: list.now,
    path: list.storePath,
    count: sessions.length,
    totalCount: list.totalCount,
    limitApplied: list.limitApplied,
    offset: list.offset > 0 ? list.offset : undefined,
    nextOffset: list.nextOffset,
    hasMore: list.hasMore,
    owners: list.ownerFacet,
    ...(list.ownerSessionCounts ? { ownerSessionCounts: list.ownerSessionCounts } : {}),
    involvingProfileId: list.involvingProfileId,
    ...(list.activityExpiresAt !== undefined ? { activityExpiresAt: list.activityExpiresAt } : {}),
    ...(list.activityPulse ? { activityPulse: list.activityPulse } : {}),
    ...(list.people
      ? {
          people: list.people,
          peopleIncomplete: list.peopleIncomplete,
          peopleSessionCount: list.peopleSessionCount,
        }
      : {}),
    defaults: policy ? policy.defaults(defaults) : defaults,
    ...sharedRows,
  };
  retainSessionListBaseMiss(result, getSessionListBaseMiss(sharedRows));
  return result;
}

const sentinel = (key: string) => key === "global" || key === "unknown";
type SelectionScope = ReturnType<SessionRowProjection["state"]["scope"]>;
// Topology retires scopes; accepted metadata updates only the affected orders.
const sessionRowSelections = new WeakMap<
  SessionRowProjection,
  Map<SelectionScope, Map<boolean, ReturnType<typeof createSessionRowSelection>>>
>();

/** Preserve federation before caller visibility and activity filters. */
export function prepareSessionRowSelection(
  projection: SessionRowProjection,
  opts: SessionsListParams,
  prepared?: Pick<SessionRowQuery, "key" | "sessionIdOrKey"> & {
    now?: number;
    rowContext?: SessionListRowContext;
    metadataPrepared?: boolean;
    ordered?: boolean;
    candidateSessionIdsOrKeys?: ReadonlySet<string>;
    candidateKeys?: ReadonlySet<string>;
  },
) {
  const { cfg, modelCatalog, scope, rowContext: residentContext } = projection.state;
  const selectedScope = scope(opts);
  const now = prepared?.now ?? Date.now();
  const rowContext = prepared?.rowContext ?? {
    ...residentContext,
    subagentRuns: residentContext.subagentRuns.atTime(now),
  };
  const keyed =
    prepared?.key !== undefined ||
    prepared?.sessionIdOrKey !== undefined ||
    prepared?.candidateKeys !== undefined;
  // Person references resolve against the full visible roster before child filtering.
  const parentSessionKey = !keyed && !opts.involvingProfileId ? opts.spawnedBy : undefined;
  const broad = !keyed && !parentSessionKey;
  const activeOnly = opts.activeOnly === true;
  let scopes = sessionRowSelections.get(projection);
  if (!scopes) {
    scopes = new Map();
    sessionRowSelections.set(projection, scopes);
    const current = scopes;
    projection.onSelectionChange((change) => {
      if (change.kind === "reset") {
        current.clear();
      } else {
        for (const variants of current.values()) {
          for (const selection of variants.values()) {
            selection.change(change);
          }
        }
      }
    });
  }
  const retained = broad && selectedScope.paths.size > 0;
  let selection = retained ? scopes.get(selectedScope)?.get(activeOnly) : undefined;
  // Unordered readers keep the resident owner's order, including replacement and federation.
  const rows =
    !selection || !prepared?.ordered
      ? (prepared?.candidateKeys
          ? Array.from(prepared.candidateKeys, (key) => ({ key }))
          : [{ key: prepared?.key, sessionIdOrKey: prepared?.sessionIdOrKey, parentSessionKey }]
        ).flatMap((query) =>
          projection.selectEntries(
            { agentId: selectedScope.agentId, ...query, sortBy: null },
            prepared?.metadataPrepared === true,
          ),
        )
      : undefined;
  if (!selection) {
    selection = createSessionRowSelection(
      cfg,
      selectedScope,
      activeOnly,
      () => projection.state.rowContext,
    );
    for (const row of rows!) {
      selection.add(selectionRow(row)!);
    }
    if (retained) {
      let variants = scopes.get(selectedScope);
      if (!variants) {
        scopes.set(selectedScope, (variants = new Map()));
      }
      variants.set(activeOnly, selection);
    }
  }
  const candidates =
    prepared?.candidateSessionIdsOrKeys &&
    projection.selectEntries(
      {
        agentId: selectedScope.agentId,
        candidateSessionIdsOrKeys: prepared.candidateSessionIdsOrKeys,
        sortBy: null,
      },
      prepared.metadataPrepared === true,
    );
  const selected = selection.read(
    prepared?.ordered ? (opts.sortBy ?? "updatedAt") : undefined,
    candidates,
    prepared?.ordered ? undefined : rows,
  );
  const { entries } = selected;
  return {
    cfg,
    opts,
    now,
    modelCatalog,
    entries,
    partitions: retained ? selected.partitions : undefined,
    configuredAgentIds: selected.configuredAgentIds,
    involvementKeys: selected.involvementKeys,
    candidateKeys(identities: ReadonlySet<string>) {
      return new Set(
        projection
          .selectEntries(
            { agentId: selectedScope.agentId, candidateSessionIdsOrKeys: identities, sortBy: null },
            prepared?.metadataPrepared === true,
          )
          .map((row) =>
            sentinel(row.key) && activeOnly ? JSON.stringify([row.key, row.agentId]) : row.key,
          ),
      );
    },
    storePath: selectedScope.path,
    userProfileIdentityById: rowContext.userProfileIdentityById,
    getRowContext: () => rowContext,
    getTarget: (key: string): (SelectionTarget & { storeKey?: string }) | undefined => {
      const winner = selected.get(key);
      return !winner || key === winner.key ? winner : { ...winner, storeKey: winner.key };
    },
    getModelFacts: (key: string) => {
      const winner = selected.get(key)!;
      return projection.modelFacts(
        { agentId: winner.agentId, key: winner.key, storePath: winner.storeTarget.storePath },
        prepared?.metadataPrepared === true,
      );
    },
    modelSearchMayMatch: (search: string) => projection.modelSearchMayMatch(search),
  };
}

export function filterAndSortSessionEntries(params: SessionListFilterParams): SessionEntryPair[] {
  return withAgentRosterFactsBatch(params.cfg, () =>
    selectSessionEntries({
      ...params,
      restrictProfileReferences: params.entryFilter !== undefined,
    }),
  ).entries;
}

/** Acquire mutable workspace names before entering synchronous visibility and selection. */
export async function prepareSessionSearchIdentityNames(
  projection: SessionRowProjection,
  opts: SessionsListParams,
  metadataPrepared = false,
) {
  const prepared = prepareSessionRowSelection(projection, opts, {
    metadataPrepared,
    ordered: true,
  });
  const scope = projection.state.scope(opts);
  const agentIds = new Set(scope.agentId ? [scope.agentId] : listAgentIds(prepared.cfg));
  for (const [key] of prepared.entries("all")) {
    const agentId = prepared.getTarget(key)?.agentId;
    if (agentId) {
      agentIds.add(agentId);
    }
  }
  const identities = await pMap(
    [...agentIds],
    (agentId) => resolveAssistantIdentityName({ cfg: prepared.cfg, agentId }),
    { concurrency: 4 },
  );
  return {
    cfg: prepared.cfg,
    names: new Map(identities.map(({ agentId, name }) => [agentId, name])),
  };
}

/** Shared synchronous membership policy for list pages and full-roster transcript search. */
export function prepareProjectedSessionList(params: {
  projection: SessionRowProjection;
  opts: SessionsListParams;
  key?: string;
  context?: GatewayRequestContext;
  client?: GatewayClient | null;
  now: number;
  metadataPrepared?: boolean;
  searchIdentities?: Awaited<ReturnType<typeof prepareSessionSearchIdentityNames>>;
  /** Reused only within one admitted caller/configuration/profile authority epoch. */
  visibility?: WeakMap<object, boolean>;
}) {
  const { projection, opts, key: exactKey, context, client, now } = params;
  if (params.searchIdentities && params.searchIdentities.cfg !== projection.state.cfg) {
    throw new Error("Session identity configuration changed while reading; retry the request");
  }
  const projectRun = context
    ? createVisibleActiveSessionRunProjector(
        projection.state.rowContext.projectedAgentRuns,
        undefined,
        context.resolveGatewayContext,
        projection.physicalPaths,
      )
    : undefined;
  const presentation = prepareSessionRowPublication(projection, now)(
    client,
    projectRun,
  ).getPresentation();
  const prepared = prepareSessionRowSelection(projection, opts, {
    key: exactKey,
    now,
    rowContext: presentation.rowContext,
    metadataPrepared: params.metadataPrepared,
    ordered: true,
    candidateSessionIdsOrKeys: opts.activeOnly
      ? projectRun?.candidateSessionIdsOrKeys()
      : undefined,
  });
  const { getTarget } = prepared;
  const { active } = presentation;
  const identity = gatewayClientSessionCreator(client ?? null)?.id;
  const filters: SessionListFilterParams = {
    ...prepared,
    identityNames: params.searchIdentities?.names,
    entriesSorted: true,
    involvingActorId: opts.involvingMe ? identity : undefined,
    ownerFirstActorId: opts.ownerFirst ? identity : undefined,
    restrictProfileReferences: client !== undefined,
    projectActiveRun: context ? (key) => active(getTarget(key)!)! : undefined,
    entryFilter:
      (client === undefined || !presentation.sharing.entryFilter) &&
      opts.hasBoard === undefined &&
      !opts.activeOnly
        ? undefined
        : (key, entry, row) => {
            const storeKey = row.storeKey ?? key;
            // Invitations can change without replacing the entry retained across yields.
            const visibility =
              presentation.sharing.sessionCap === "invited" ? undefined : params.visibility;
            let visible = visibility?.get(entry);
            if (visible === undefined) {
              const selected = getTarget(key)!;
              visible =
                client === undefined ||
                (presentation.sharing.entryFilter?.(
                  storeKey,
                  entry,
                  Boolean(
                    presentation.sharing.identity &&
                    projection.hasMembership(
                      selected.storeTarget.storePath,
                      storeKey,
                      presentation.sharing.identity.id,
                    ),
                  ),
                ) ??
                  true);
              visibility?.set(entry, visible);
            }
            return (
              visible &&
              (opts.hasBoard === undefined || row.hasBoard === opts.hasBoard) &&
              (!opts.activeOnly || Boolean(active(getTarget(key)!)?.active))
            );
          },
  };
  const ownerRunningCandidateKeys = () =>
    prepared.candidateKeys(
      new Set([
        ...(projectRun?.candidateSessionIdsOrKeys() ?? []),
        ...[...presentation.rowContext.subagentRuns.requesterSessionKeys()].filter(
          (key) => presentation.rowContext.subagentRuns.countActiveDescendantRuns(key) > 0,
        ),
        ...(presentation.rowContext.projectedSubagentActivity ?? []),
      ]),
    );
  return { prepared, presentation, filters, ownerRunningCandidateKeys };
}

/** Prepare selected rows, then authorize and present them in one synchronous boundary. */
export async function listProjectedSessions(params: {
  projection: SessionRowProjection;
  opts: SessionsListParams;
  key?: string;
  context?: GatewayRequestContext;
  client?: GatewayClient | null;
  acceptsSerializedJson?: boolean;
  diagnostics?: SessionListDiagnostics;
  onResult?: (result: SessionsListResult) => void;
}): Promise<SessionsListResult> {
  const { projection, opts, key: exactKey, context, client, diagnostics } = params;
  // Search and Board filters inspect full row facts; ordinary paging selects from metadata.
  const selectionPreparation = {
    metadataOnly: !opts.search?.trim() && opts.hasBoard === undefined,
    includeCatalog: true,
  };
  return projection.withSelectionPreparation(async () => {
    const dirtyRowCount = projection.dirtyRowCount;
    const materializedBefore = projection.materializedCount;
    diagnostics?.mark("materialize");
    const waitStarted = performance.now();
    let yieldCount = 0;
    let searchIdentities: Awaited<ReturnType<typeof prepareSessionSearchIdentityNames>> | undefined;
    do {
      yieldCount++;
      await projection.prepareSelection({ ...selectionPreparation, yieldForCatalog: true });
      if (opts.search?.trim()) {
        searchIdentities = await prepareSessionSearchIdentityNames(projection, opts, true);
      }
    } while (
      projection.needsSelectionPreparation(selectionPreparation) ||
      (searchIdentities && searchIdentities.cfg !== projection.state.cfg)
    );
    let prepareSyncMs = 0;
    const selectPage = () => {
      const started = performance.now();
      const syncCpu = diagnostics?.startSyncCpu();
      try {
        diagnostics?.mark("storeLoad");
        const now = Date.now();
        const { presentation, prepared, filters, ownerRunningCandidateKeys } =
          prepareProjectedSessionList({
            projection,
            opts,
            key: exactKey,
            context,
            client,
            now,
            searchIdentities,
            metadataPrepared: true,
          });
        diagnostics?.mark("filterSetup");
        const select = (retained?: WeakMap<object, SessionListFilteredEntries>) =>
          withAgentRosterFactsBatch(prepared.cfg, () =>
            selectSessionEntries({
              ...filters,
              defaultLimit: 100,
              partitions: prepared.partitions,
              retained,
            }),
          );
        const selection =
          params.acceptsSerializedJson && exactKey === undefined
            ? presentation.select(opts, select)
            : select();
        return {
          now,
          presentation,
          prepared,
          selection: projectSessionOwnerRunningCounts(
            filters,
            selection,
            ownerRunningCandidateKeys,
          ),
        };
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
        const queries: Lookup[] = [];
        for (const [key] of page.selection.entries) {
          const target = page.prepared.getTarget(key);
          if (target) {
            queries.push({
              agentId: target.agentId,
              key: target.key,
              storePath: target.storeTarget.storePath,
            });
          }
        }
        return queries;
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
          const sessions: GatewaySessionRow[] = [];
          const rowOptions = [false, true].map((includeTranscriptFields) =>
            [false, true].map((isSentinel) => ({
              includeDerivedTitles: opts.includeDerivedTitles && includeTranscriptFields,
              includeLastMessage: opts.includeLastMessage && includeTranscriptFields,
              includeActivitySummary: opts.includeActivitySummary === true,
              rowMode: opts.rowMode,
              omitSentinelChildren: opts.activeOnly && isSentinel,
              childArchiveFilter: opts.archived ?? false,
            })),
          );
          for (let index = 0; index < selection.entries.length; index++) {
            const [key] = selection.entries[index]!;
            const target = getTarget(key);
            if (!target) {
              continue;
            }
            const includeTranscriptFields =
              (!opts.includeDerivedTitles && !opts.includeLastMessage) ||
              index < SESSIONS_LIST_TRANSCRIPT_LIMIT + selection.ownerCount;
            const { row: sharedRow, record } = presentation.snapshot(
              {
                agentId: target.agentId,
                key: target.key,
                storePath: target.storeTarget.storePath,
              },
              rowOptions[Number(includeTranscriptFields)]![
                opts.activeOnly && sentinel(target.key) ? 1 : 0
              ]!,
            );
            if (!sharedRow || !record) {
              continue;
            }
            if ((record.materializedSequence ?? 0) > materializedBefore) {
              materializedRowCount++;
            }
            if (params.acceptsSerializedJson) {
              sessions.push(sharedRow);
            } else {
              const row = { ...sharedRow };
              bindSessionListRowRead(row, { projection, record, client });
              sessions.push(row);
            }
          }
          diagnostics?.mark("decoration");
          const result = buildSessionsListResult(
            prepared,
            { ...selection, now, storePath: prepared.storePath },
            params.acceptsSerializedJson ? presentation.list(sessions, opts) : { sessions },
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
      { selection: selectionPreparation },
    );
  });
}
