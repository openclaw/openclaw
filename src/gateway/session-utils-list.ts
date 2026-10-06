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
import {
  SESSIONS_LIST_OWNER_LIMIT,
  SESSIONS_LIST_TRANSCRIPT_LIMIT,
} from "../shared/session-list-limits.js";
import { runSynchronousWork, type SynchronousWork } from "../shared/synchronous-work.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import { resolveGatewayModelSelectionPolicy } from "./server-methods/session-model-selection-policy.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { readPreparedGatewayModelMetadata } from "./server-model-catalog-view.js";
import type { SessionListDiagnostics } from "./session-list-diagnostics.types.js";
import {
  filterSessionEntries,
  type SessionEntrySelection,
  type SessionListFilterParams,
} from "./session-list-filters.js";
import {
  compareSessionEntryPairs,
  sortAndLimitSessionEntries,
  type SessionEntryPair,
} from "./session-list-order.js";
import { bindSessionListRowRead } from "./session-list-read-result.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import {
  identity as rowIdentity,
  selectionRow,
  type Query as SessionRowQuery,
  type SelectionRow as SelectionTarget,
  type SelectionChange,
} from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { getSessionDefaults } from "./session-utils-model.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";

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
    sessions,
  };
}

const sentinel = (key: string) => key === "global" || key === "unknown";
type SelectionScope = ReturnType<SessionRowProjection["state"]["scope"]>;
type IndexedTarget = { row: SelectionTarget; pair: SessionEntryPair; position: number };

function createSessionRowSelection(
  cfg: OpenClawConfig,
  scope: SelectionScope,
  activeOnly: boolean,
) {
  const groups = new Map<string, Map<string, IndexedTarget>>();
  const winners = new Map<string, IndexedTarget>();
  const duplicates = new Set<string>();
  const orders = new Map<NonNullable<SessionsListParams["sortBy"]>, SessionEntryPair[]>();
  let position = 0;
  const keyFor = (row: Pick<SelectionTarget, "key" | "agentId">) =>
    sentinel(row.key) && activeOnly ? JSON.stringify([row.key, row.agentId]) : row.key;
  const update = (id: string, key: string, row?: SelectionTarget) => {
    const previous = groups.get(key);
    const oldWinner = winners.get(key);
    const candidate = previous?.get(id);
    const eligible =
      row &&
      scope.paths.has(row.storeTarget.storePath) &&
      (!scope.agentId || row.agentId === scope.agentId) &&
      (!scope.configuredAgentIds ||
        isConfiguredGatewaySessionEntry(cfg, scope.configuredAgentIds, row.key, row.entry));
    const group = previous ?? new Map<string, IndexedTarget>();
    if (eligible) {
      group.set(id, { row, pair: [key, row.entry], position: candidate?.position ?? position++ });
      groups.set(key, group);
    } else {
      group.delete(id);
      if (!group.size) {
        groups.delete(key);
      }
    }
    let winner: IndexedTarget | undefined;
    for (const target of group.values()) {
      if (
        !winner ||
        scope.paths.get(target.row.storeTarget.storePath)! <
          scope.paths.get(winner.row.storeTarget.storePath)!
      ) {
        winner = target;
      }
    }
    if (group.size > 1 && !sentinel(winner!.row.key)) {
      duplicates.add(key);
    } else {
      duplicates.delete(key);
    }
    if (winner) {
      winners.set(key, winner);
    } else {
      winners.delete(key);
    }
    if (winner === oldWinner) {
      return;
    }
    for (const [sortBy, entries] of orders) {
      const locate = (pair: SessionEntryPair) => {
        let lo = 0,
          hi = entries.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (compareSessionEntryPairs(entries[mid]!, pair, sortBy) < 0) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        return lo;
      };
      if (oldWinner) {
        entries.splice(locate(oldWinner.pair), 1);
      }
      if (winner) {
        entries.splice(locate(winner.pair), 0, winner.pair);
      }
    }
  };
  return {
    add(row: SelectionTarget) {
      update(rowIdentity(row), keyFor(row), row);
    },
    change(change: Exclude<SelectionChange, { kind: "reset" }>) {
      update(change.id, keyFor(change), change.row);
    },
    read(sortBy?: SessionsListParams["sortBy"]) {
      for (const key of duplicates) {
        throw canonicalSessionKeyMigrationRequiredError(
          `duplicate rows resolve to canonical session key ${key}`,
        );
      }
      let entries = sortBy && orders.get(sortBy);
      if (!entries) {
        const targets = [...winners.values()];
        if (!sortBy) {
          targets.sort((a, b) => a.position - b.position);
        }
        entries = targets.map((target) => target.pair);
        if (sortBy) {
          entries.sort((a, b) => compareSessionEntryPairs(a, b, sortBy));
          orders.set(sortBy, entries);
        }
      }
      return { entries, get: (key: string) => winners.get(key)?.row };
    },
  };
}

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
  },
) {
  const { cfg, modelCatalog, scope, rowContext: residentContext } = projection.state;
  const selectedScope = scope(opts);
  const now = prepared?.now ?? Date.now();
  const rowContext = prepared?.rowContext ?? {
    ...residentContext,
    subagentRuns: residentContext.subagentRuns.atTime(now),
  };
  const keyed = prepared?.key !== undefined || prepared?.sessionIdOrKey !== undefined;
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
    selection = createSessionRowSelection(cfg, selectedScope, activeOnly);
    for (const row of projection.selectEntries(
      {
        agentId: selectedScope.agentId,
        key: prepared?.key,
        sessionIdOrKey: prepared?.sessionIdOrKey,
        parentSessionKey,
        sortBy: null,
      },
      prepared?.metadataPrepared === true,
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
  const selected = selection.read(prepared?.ordered ? (opts.sortBy ?? "updatedAt") : undefined);
  const { entries } = selected;
  return {
    cfg,
    opts,
    now,
    modelCatalog,
    entries,
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
}) {
  const { projection, opts, key: exactKey, context, client, now } = params;
  if (params.searchIdentities && params.searchIdentities.cfg !== projection.state.cfg) {
    throw new Error("Session identity configuration changed while reading; retry the request");
  }
  const presentation = prepareSessionRowPublication(projection, now)(
    client,
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
    metadataPrepared: params.metadataPrepared,
    ordered: true,
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
  acceptsSerializedJson?: boolean;
  diagnostics?: SessionListDiagnostics;
  onResult?: (result: SessionsListResult) => void;
}): Promise<SessionsListResult> {
  const { projection, opts, key: exactKey, context, client, diagnostics } = params;
  return projection.withSelectionPreparation(async () => {
    const dirtyRowCount = projection.dirtyRowCount;
    const materializedBefore = projection.materializedCount;
    diagnostics?.mark("materialize");
    const waitStarted = performance.now();
    let yieldCount = 0;
    let searchIdentities: Awaited<ReturnType<typeof prepareSessionSearchIdentityNames>> | undefined;
    do {
      yieldCount++;
      await projection.prepareSelection(true);
      if (opts.search?.trim()) {
        searchIdentities = await prepareSessionSearchIdentityNames(projection, opts, true);
      }
    } while (
      projection.needsSelectionPreparation() ||
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
          metadataPrepared: true,
        });
        diagnostics?.mark("filterSetup");
        const select = () =>
          withAgentRosterFactsBatch(prepared.cfg, () =>
            runSynchronousWork(selectSessionEntries({ ...filters, defaultLimit: 100 })),
          );
        const selection =
          params.acceptsSerializedJson && exactKey === undefined
            ? presentation.select(opts, select)
            : select();
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
            ? [
                {
                  agentId: target.agentId,
                  key: target.key,
                  storePath: target.storeTarget.storePath,
                },
              ]
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
            const includeTranscriptFields =
              index < SESSIONS_LIST_TRANSCRIPT_LIMIT + selection.ownerCount;
            const sharedRow = presentation.present(record, {
              includeDerivedTitles: opts.includeDerivedTitles && includeTranscriptFields,
              includeLastMessage: opts.includeLastMessage && includeTranscriptFields,
              includeActivitySummary: opts.includeActivitySummary === true,
              rowMode: opts.rowMode,
              omitSentinelChildren: opts.activeOnly && sentinel(record.key),
              childArchiveFilter: opts.archived ?? false,
            });
            if (!sharedRow) {
              return [];
            }
            if ((record.materializedSequence ?? 0) > materializedBefore) {
              materializedRowCount++;
            }
            if (params.acceptsSerializedJson) {
              return [sharedRow];
            }
            const row = { ...sharedRow };
            bindSessionListRowRead(row, { projection, record, client });
            return [row];
          });
          diagnostics?.mark("decoration");
          const result = buildSessionsListResult(
            prepared,
            { ...selection, now, storePath: prepared.storePath },
            params.acceptsSerializedJson ? presentation.list(sessions, opts) : sessions,
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
      { selection: true },
    );
  });
}
