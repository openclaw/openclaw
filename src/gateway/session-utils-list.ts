import { performance } from "node:perf_hooks";
import pMap from "p-map";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { SESSIONS_LIST_TRANSCRIPT_LIMIT } from "../shared/session-list-limits.js";
import { runSynchronousWork } from "../shared/synchronous-work.js";
import { resolveAssistantIdentityName } from "./assistant-identity.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import { resolveGatewayModelSelectionPolicy } from "./server-methods/session-model-selection-policy.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { readPreparedGatewayModelMetadata } from "./server-model-catalog-view.js";
import type { SessionListDiagnostics } from "./session-list-diagnostics.types.js";
import {
  resolveSessionListSearchModelIdentity,
  type SessionEntrySelection,
  type SessionListFilterParams,
} from "./session-list-filters.js";
import type { SessionEntryPair } from "./session-list-order.js";
import { bindSessionListRowRead } from "./session-list-read-result.js";
import { selectSessionEntries } from "./session-list-selection.js";
import { selectSessionListPageInWorker } from "./session-list-worker.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import {
  prepareSessionRowPublication,
  shareSidebarSessionRows,
} from "./session-row-presentation.js";
import {
  identity as rowIdentity,
  selectionRow,
  type Query as SessionRowQuery,
  type SelectionRow as SelectionTarget,
} from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { createSessionRowSelection } from "./session-row-selection.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { getSessionDefaults } from "./session-utils-model.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";

export { selectSessionEntries } from "./session-list-selection.js";

function buildSessionsListResult(
  params: Pick<SessionListFilterParams, "cfg" | "opts" | "modelCatalog">,
  list: Omit<SessionEntrySelection, "entries"> & { now: number; storePath: string },
  { sessions, previousRows }: { sessions: GatewaySessionRow[]; previousRows?: GatewaySessionRow[] },
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
    ...(opts.rowMode === "sidebar"
      ? shareSidebarSessionRows(sessions, opts.ifRowsRevision, previousRows)
      : { sessions }),
  };
}

const sentinel = (key: string) => key === "global" || key === "unknown";
type SelectionScope = ReturnType<SessionRowProjection["state"]["scope"]>;
// Topology retires scopes; accepted metadata updates only the affected orders.
const sessionRowSelections = new WeakMap<
  SessionRowProjection,
  Map<SelectionScope, Map<boolean, ReturnType<typeof createSessionRowSelection<SelectionTarget>>>>
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
  // Catalog adoption consumes raw resident order; exact/child reads retain their narrow selector.
  const retained = broad && prepared?.ordered && selectedScope.paths.size > 0;
  let selection = retained ? scopes.get(selectedScope)?.get(activeOnly) : undefined;
  if (!selection) {
    selection = createSessionRowSelection(
      cfg,
      selectedScope,
      activeOnly,
      () => projection.state.rowContext,
    );
    const queries = prepared?.candidateKeys
      ? [...prepared.candidateKeys].map((key) => ({ key }))
      : [{ key: prepared?.key, sessionIdOrKey: prepared?.sessionIdOrKey, parentSessionKey }];
    for (const row of queries.flatMap((query) =>
      projection.selectEntries(
        {
          agentId: selectedScope.agentId,
          ...query,
          sortBy: null,
        },
        prepared?.metadataPrepared === true,
      ),
    )) {
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
    Array.from(prepared.candidateSessionIdsOrKeys).flatMap((sessionIdOrKey) =>
      projection.selectEntries(
        { agentId: selectedScope.agentId, sessionIdOrKey, sortBy: null },
        prepared.metadataPrepared === true,
      ),
    );
  const selected = selection.read(
    prepared?.ordered ? (opts.sortBy ?? "updatedAt") : undefined,
    candidates,
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
    candidateKeys(identities: Iterable<string>) {
      return new Set(
        Array.from(identities).flatMap((sessionIdOrKey) =>
          projection
            .selectEntries(
              { agentId: selectedScope.agentId, sessionIdOrKey, sortBy: null },
              prepared?.metadataPrepared === true,
            )
            .map((row) =>
              sentinel(row.key) && activeOnly ? JSON.stringify([row.key, row.agentId]) : row.key,
            ),
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
        context,
        projection.state.rowContext.projectedAgentRuns,
      )
    : undefined;
  const presentation = prepareSessionRowPublication(projection, now)(client, projectRun);
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
    projectActiveRun: context
      ? (key, entry, agentId) => active(getTarget(key)?.key ?? key, entry, agentId)!
      : undefined,
    entryFilter: (key, entry, row) => {
      const storeKey = row.storeKey ?? key;
      let visible = params.visibility?.get(entry);
      if (visible === undefined) {
        visible =
          client === undefined || (presentation.sharing.entryFilter?.(storeKey, entry) ?? true);
        params.visibility?.set(entry, visible);
      }
      return (
        visible &&
        (opts.hasBoard === undefined || row.hasBoard === opts.hasBoard) &&
        (!opts.activeOnly || Boolean(active(storeKey, entry, row.agentId)?.active))
      );
    },
  };
  const ownerRunningCandidateKeys = () =>
    prepared.candidateKeys(
      new Set([
        ...(projectRun?.candidateSessionIdsOrKeys() ?? []),
        ...presentation.rowContext.subagentRuns.requesterSessionKeys(),
        ...(presentation.rowContext.projectedSubagentActivity ?? []),
      ]),
    );
  return { prepared, presentation, filters, ownerRunningCandidateKeys };
}

/** Select and render in the worker; publish only under current synchronous disclosure authority. */
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
    for (;;) {
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
      const page = await selectSessionListPageInWorker(projection, {
        opts,
        key: exactKey,
        context,
        client,
        searchIdentities,
        // Plugin-owned model policy stays with the host preparation owner.
        prepareSearchRows: opts.search?.trim()
          ? (now) => {
              const { prepared, filters } = prepareProjectedSessionList({
                projection,
                opts,
                key: exactKey,
                context,
                client,
                now,
                metadataPrepared: true,
              });
              return new Map(
                [...prepared.entries("all")].map(([rowKey]) => {
                  const target = prepared.getTarget(rowKey)!;
                  const { selectedModel, rowModelIdentity, thinkingProjection } =
                    prepared.getModelFacts(rowKey);
                  return [
                    rowIdentity(target),
                    {
                      modelFacts: { selectedModel, rowModelIdentity, thinkingProjection },
                      modelIdentity: resolveSessionListSearchModelIdentity(filters, rowKey),
                    },
                  ];
                }),
              );
            }
          : undefined,
        diagnostics,
      });
      if (!page) {
        await projection.prepareSelection(selectionPreparation);
        continue;
      }
      // Exact preparation releases its pins before worker rendering; keep this page resident
      // through publication, including when another archived page changes the cache limit.
      const archivedRows = projection.retainArchiveRows();
      using _ = { [Symbol.dispose]: () => archivedRows.release() };
      archivedRows.update(page.archivedRowIds);
      const capturedPage = await withReadySessionRows(
        projection,
        () => page.queries,
        () => {
          const started = performance.now();
          const cpu = diagnostics?.startSyncCpu();
          try {
            const projectRun = context
              ? createVisibleActiveSessionRunProjector(
                  context,
                  projection.state.rowContext.projectedAgentRuns,
                )
              : undefined;
            const presentation = prepareSessionRowPublication(projection, page.now)(
              client,
              projectRun,
            );
            if (!page.isCurrent(presentation.sharing.cacheKey)) {
              return undefined;
            }
            const rows = page.queries.map((target, index) => {
              const includeTranscriptFields =
                index < SESSIONS_LIST_TRANSCRIPT_LIMIT + page.selection.ownerCount;
              return presentation.capture(target, {
                includeDerivedTitles: opts.includeDerivedTitles && includeTranscriptFields,
                includeLastMessage: opts.includeLastMessage && includeTranscriptFields,
                includeActivitySummary: opts.includeActivitySummary === true,
                rowMode: opts.rowMode,
                omitSentinelChildren: opts.activeOnly && sentinel(target.key),
                childArchiveFilter: opts.archived ?? false,
              });
            });
            return {
              rows,
              audience: presentation.audienceKey,
              sharingRevision: projection.sharingRevision,
            };
          } finally {
            if (diagnostics) {
              diagnostics.projection.prepareSyncMs += performance.now() - started;
              diagnostics.finishSyncCpu("prepareThreadCpuMs", cpu);
            }
          }
        },
        { selection: selectionPreparation },
      );
      if (!capturedPage) {
        continue;
      }
      const pendingRows = capturedPage.rows.filter((captured) => captured.work);
      const renderedRows = pendingRows.length
        ? await page.render(pendingRows.map((captured) => captured.work!.input))
        : [];
      if (!renderedRows) {
        continue;
      }
      const pageResult = (() => {
        // The prepared page remains usable until its owner publishes a change. A second
        // preparation would reacquire the same facts after every worker round trip.
        if (
          projection.sharingRevision !== capturedPage.sharingRevision ||
          projection.needsSelectionPreparation(selectionPreparation)
        ) {
          return undefined;
        }
        const resumed = performance.now();
        const { now, selection, cfg, modelCatalog, storePath } = page;
        const prepareCpu = diagnostics?.startSyncCpu();
        let presentation: ReturnType<ReturnType<typeof prepareSessionRowPublication>>;
        try {
          const projectRun = context
            ? createVisibleActiveSessionRunProjector(
                context,
                projection.state.rowContext.projectedAgentRuns,
              )
            : undefined;
          presentation = prepareSessionRowPublication(projection, now)(client, projectRun);
        } finally {
          if (diagnostics) {
            diagnostics.projection.prepareSyncMs += performance.now() - resumed;
            diagnostics.finishSyncCpu("prepareThreadCpuMs", prepareCpu);
          }
        }
        const preparedAt = performance.now();
        // Worker-selected facets disclose roster facts too; recheck the whole audience.
        if (
          !page.isCurrent(presentation.sharing.cacheKey) ||
          presentation.audienceKey !== capturedPage.audience
        ) {
          return undefined;
        }
        const prepared = { cfg, opts, modelCatalog };
        diagnostics?.mark("sharing");
        diagnostics?.mark("rows");
        const rowsStarted = performance.now();
        let syncCpu = diagnostics?.startSyncCpu();
        try {
          let materializedRowCount = 0;
          projection.setArchivePageSize(page.queries.length);
          const sessions: GatewaySessionRow[] = [];
          let renderedIndex = 0;
          for (const captured of capturedPage.rows) {
            const rendered = captured.work ? renderedRows[renderedIndex++]! : undefined;
            const shared = rendered
              ? captured.work!.publish(rendered.row, rendered.encoded)
              : captured.row;
            if (!shared || !captured.record) {
              continue;
            }
            const sharedRow = presentation.projectModels(shared, captured);
            const record = captured.record;
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
            { ...selection, now, storePath },
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
              prepareSyncMs: diagnostics.projection.prepareSyncMs,
              rowSyncMs: performance.now() - rowsStarted,
              yieldWaitMs: preparedAt - waitStarted - diagnostics.projection.prepareSyncMs,
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
      })();
      if (pageResult !== undefined) {
        return pageResult;
      }
    }
  });
}
