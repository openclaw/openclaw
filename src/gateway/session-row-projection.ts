import { AsyncLocalStorage } from "node:async_hooks";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import {
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentSessionListReadCache,
} from "../agents/subagents/registry/subagent-registry-state.js";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { retainUserProfileCatalog } from "../state/user-profile-list.js";
import type { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import { ensureSessionGroupCatalog } from "./session-group-catalog.js";
import { createSessionMembershipProjection } from "./session-membership-projection.js";
import { createSessionProjectionDrain, yieldSessionListWork } from "./session-projection-work.js";
import {
  createSessionRowMembershipReadAccess,
  createSessionRowEntryReadAccess,
} from "./session-row-membership-read.js";
import { readSessionRowModelFacts } from "./session-row-model-facts.js";
import { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import {
  createSessionRowAncestorReads,
  createSessionRowRelationReads,
} from "./session-row-projection-ancestors.js";
import {
  createSessionRowProjectionArchive,
  isColdArchivedSessionRow as isCold,
} from "./session-row-projection-archive.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import { createSessionRowProjectionCatalog } from "./session-row-projection-catalog.js";
import { createSessionRowProjectionContext } from "./session-row-projection-context.js";
import { createSessionRowCreatorIndex } from "./session-row-projection-identities.js";
import {
  lookupSessionRow,
  findSessionRowById,
  readResidentSessionRow,
} from "./session-row-projection-materialize.js";
import type { PreparedSessionRowDatabaseFacts } from "./session-row-projection-read.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowRefresh } from "./session-row-projection-refresh.js";
import { createSessionRowProjectionTranscriptUpdates } from "./session-row-projection-transcript.js";
import {
  createSessionRowScopeMatcher,
  prepareSessionRowScopes,
  selectMatchingSessionRows,
  selectSessionRowEntries,
} from "./session-row-scope.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

/** Committed publications own invalidation; each admitted physical store is hydrated once. */
export async function createSessionRowProjection(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  modelCatalog?: records.Inputs["modelCatalog"];
  getModelCatalog?: () => Promise<records.Inputs["modelCatalog"]>;
  context?: Parameters<typeof readSessionRowFacts>[0]["context"];
  placementFactsReader?: Pick<WorkerSessionPlacementStore, "readProjection">;
}) {
  // Publications may borrow startup admission; projection work retains its own authority.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  while (!getSubagentSessionListReadSnapshotIdentity()) {
    await prepareSubagentSessionListReadCache();
  }
  let cfg = params.getConfig?.() ?? params.cfg;
  const rows = new Map<string, records.Row>();
  const creators = createSessionRowCreatorIndex();
  const membership = createSessionMembershipProjection();
  const { invalidateRowMembership, readSessionRowEntry, createStoreRead } =
    createSessionRowEntryReadAccess(membership);
  let stores = new Map<string, records.SessionRowStore>();
  const byStore = new Map<string, Set<string>>(),
    byAgent = new Map<string, Set<string>>();
  const byParent = new Map<string, Set<string>>(),
    byKey = new Map<string, Set<string>>();
  const indexes = { byStore, byAgent, byParent, byKey };
  const dirty = new Set<string>();
  let topologyDirty = true,
    disposed = false;
  const prepareRegistryFacts = (): Promise<void> | undefined =>
    !disposed && !inOwnerContext(getSubagentSessionListReadSnapshotIdentity)
      ? inOwnerContext(prepareSubagentSessionListReadCache)
      : undefined;
  const placementFacts = createSessionRowPlacementProjection(
    params.placementFactsReader,
    prepareRegistryFacts,
  );
  let epoch = 0;
  let databaseRevision = 0;
  // Releasing the token also releases weakly held list selections from the previous revision.
  let revisionToken: object | undefined;
  let materializedCount = 0;
  let scope: ReturnType<typeof prepareSessionRowScopes>;
  const ensureMaterialized = createSessionProjectionDrain({
    beforeEnsure() {
      if (!disposed && !catalog.needsInitialRead) {
        void inOwnerContext(() => catalog.refresh());
      }
    },
    hasWork: needsMaterialization,
    refresh: () => refreshBatch(),
    needsYield: () => dirty.size > 0 || topologyDirty,
    // Adopt published catalog reads without waiting for an in-flight renewal.
    idle: () => (catalog.isRefreshing ? yieldSessionListWork() : Promise.resolve()),
    runAsOwner: inOwnerContext,
  });
  const catalog = createSessionRowProjectionCatalog({
    modelCatalog: params.modelCatalog,
    getModelCatalog: params.getModelCatalog,
    onInvalidated: () => mark({ all: true, scope: "catalog" }),
    onRefreshed(changed) {
      if (changed) {
        // Rows served during renewal need new materializations only when their model facts changed.
        epoch++;
        databaseRevision++;
        revisionToken = undefined;
        metadata.invalidate({ all: true, scope: "catalog" });
        archive.invalidateRows({ all: true, scope: "catalog" }, rows.values());
      }
      void ensureMaterialized().catch(() => {});
    },
  });
  const metadata = createSessionRowProjectionContext();
  const backfill = createSessionRowProjectionBackfill({
    ready: ensureMaterialized,
    read: (id) => rows.get(id),
    current: (row) => !topologyDirty && archive.isCurrentMaterialization(row) && isCurrent(row),
    publish(row, fields) {
      const current = rows.get(records.identity(row));
      if (
        records.ready(current) &&
        records.publishTranscriptFields(current, fields, cfg, metadata.current)
      ) {
        // Optional presentation leaves independently pending stored facts dirty.
        revisionToken = undefined;
      }
    },
  });
  const archive = createSessionRowProjectionArchive({
    rows,
    dirty,
    put,
    enqueue: (id, change) => backfill.enqueue(id, change),
    release(id) {
      transcriptUpdates.remove(id);
      backfill.remove(id);
      dirty.delete(id);
    },
    prepare(row) {
      metadata.prepare(epoch, cfg, matching, put);
      const current = acquireEntry(row, readSessionRowEntry(row));
      if (current && materialize(current)) {
        backfill.enqueue(records.identity(current));
      }
      return current;
    },
  });
  const markRelated = (row: records.Row, includeChildren = true) =>
    archive.markRelated(row, indexes, includeChildren);
  function remove(id: string) {
    archive.forget(id);
    transcriptUpdates.remove(id);
    const row = rows.get(id);
    if (row) {
      revisionToken = undefined;
      invalidateRowMembership(row);
      markRelated(row);
      creators.update(row);
      records.index(row, indexes, true);
      rows.delete(id);
      if (row.entry && !byKey.has(`id:${row.entry.sessionId}`)) {
        placementFacts.forget(row.entry.sessionId);
      }
    }
    dirty.delete(id);
    backfill.remove(id);
  }
  function put(row: records.Row) {
    revisionToken = undefined;
    const previous = rows.get(records.identity(row));
    creators.update(previous, row);
    if (previous) {
      if (previous.generation !== row.generation) {
        transcriptUpdates.remove(records.identity(row));
      }
      records.index(previous, indexes, true);
    }
    rows.set(records.identity(row), row);
    records.index(row, indexes);
    placementFacts.update(row, previous, (sessionId) =>
      [...(byKey.get(`id:${sessionId}`) ?? [])].flatMap((id) => rows.get(id) ?? []),
    );
  }
  function acquireEntry(row: records.Row, storedEntry: SessionEntry | undefined) {
    if (storedEntry?.archivedAt !== undefined) {
      inOwnerContext(() => metadata.prepare(epoch, cfg, matching, put));
    }
    return records.acquireSessionRowEntry({
      row,
      storedEntry,
      cfg,
      context: metadata.current,
      remove,
      put,
      markRelated,
      archive,
    });
  }
  function matching(query: records.Query, kind = "key") {
    return selectMatchingSessionRows({ rows, indexes, scope }, query, kind);
  }
  const lookup = (query: records.Lookup) =>
    lookupSessionRow(query, { disposed, cfg, matching, storePaths: stores.keys() });
  function referenced(ref: string) {
    return records.firstReferenced(ref, rows, byKey, stores.keys());
  }
  function topology() {
    const revision = epoch;
    cfg = params.getConfig?.() ?? cfg;
    const admitted = new Set<string>();
    const storeRead = createStoreRead({ stores, rows, byStore });
    const loaded = loadCombinedSessionStoreForGatewayCore(cfg, {
      includeIncognito: false,
      preserveSentinelOwners: "physical",
      loadEntries: storeRead.loadEntries,
      onStoreLoaded(target, agentId, discovery) {
        const source = storeRead.sources.get(target.storePath);
        if (source) {
          source.agentId = agentId;
          source.discoveryAgentId = discovery?.agentId ?? null;
          source.discoveryOrder = discovery?.order;
        }
      },
    });
    for (const [key, target] of loaded.targetsBySessionKey) {
      const entry = target.entry;
      if (!entry || entry.incognito || isIncognitoSessionKey(key)) {
        continue;
      }
      const fields = {
        key: target.storeKey ?? key,
        agentId: target.agentId,
        storeTarget: target.storeTarget,
      };
      const id = records.identity(fields);
      admitted.add(id);
      if (!rows.has(id) || storeRead.replaced.has(target.storeTarget.storePath)) {
        remove(id);
        const row = acquireEntry(records.create(fields), entry);
        if (row && !isCold(row)) {
          dirty.add(id);
          backfill.enqueue(id);
        }
      } else {
        const row = rows.get(id)!;
        if (row.entry?.archivedAt !== undefined) {
          acquireEntry(row, entry);
        }
      }
    }
    for (const id of rows.keys()) {
      if (!admitted.has(id)) {
        remove(id);
      }
    }
    stores = storeRead.sources;
    membership.updateTargets(
      [...stores.values()].map((source) => ({
        agentId: source.target.agentId,
        storePath: source.target.storePath,
        discoveryAgentId: source.discoveryAgentId,
        discoveryOrder: source.discoveryOrder,
        identity: source.identity,
        birthtime: source.birthtime,
        filename: source.filename,
      })),
    );
    scope = prepareSessionRowScopes(
      cfg,
      byAgent.keys(),
      new Map([...stores].map(([locator, source]) => [source.filename, locator])),
    );
    topologyDirty = epoch !== revision;
  }
  function mark(change: SessionRowChange) {
    epoch++;
    revisionToken = undefined;
    const presentationOnly = metadata.invalidate(change) && !change.factsInvalidated;
    if (!presentationOnly) {
      databaseRevision++;
    }
    if ("all" in change) {
      placementFacts.invalidateChange(change);
      topologyDirty ||= change.scope === "stores" || change.scope === "config";
      if (change.scope === "catalog" || change.scope === "config") {
        catalog.invalidate();
      }
      // Renewal serves the old catalog until its replacement is adopted.
      if (!presentationOnly && (change.scope !== "catalog" || !params.getModelCatalog)) {
        archive.invalidateRows(
          change,
          typeof change.scope === "string" ? rows.values() : matching(change.scope),
        );
      } else if (!presentationOnly) {
        for (const row of rows.values()) {
          row.pendingDatabaseFacts = undefined;
        }
      }
    } else if (change.scope === "automation") {
      records.markAutomation(
        matching({ key: change.sessionKey }).filter((row) => !isCold(row)),
        change.agentId,
        dirty,
      );
    } else if (!presentationOnly) {
      const query = { ...change, key: change.sessionKey };
      const exact = matching(query);
      const registryFactsReady = inOwnerContext(getSubagentSessionListReadSnapshotIdentity);
      for (const previous of new Set([...exact, ...matching(query, "id")])) {
        previous.pendingDatabaseFacts = undefined;
        if (previous.entry) {
          placementFacts.invalidate(previous.entry.sessionId);
        }
        const row = inOwnerContext(() => {
          const entry = readSessionRowEntry(previous);
          markRelated(previous, records.changesSessionRowDependents(previous.storedEntry, entry));
          previous.sharingEntry = entry;
          if (entry?.archivedAt !== undefined && !registryFactsReady) {
            // Committed row changes must survive an unrelated compact-facts refill.
            return archive.deferAcquisition({ ...previous, hasBoard: undefined });
          }
          return isCold(previous) || records.changesRowStructure(previous, entry)
            ? acquireEntry({ ...previous, hasBoard: undefined }, entry)
            : previous;
        });
        if (row && !isCold(row)) {
          dirty.add(records.identity(row));
          backfill.enqueue(records.identity(row));
        }
      }
      if (
        !exact.length &&
        !isInternalSessionEffectsKey(change.sessionKey) &&
        !isIncognitoSessionKey(change.sessionKey)
      ) {
        const matches = createSessionRowScopeMatcher(change, scope);
        for (const source of stores.values()) {
          const agentId = parseAgentSessionKey(change.sessionKey)?.agentId ?? source.agentId;
          const row = records.create({
            key: change.sessionKey,
            agentId,
            storeTarget: source.target,
          });
          if (!matches(row) || (!change.storePath && agentId !== source.agentId)) {
            continue;
          }
          const admitted = inOwnerContext(() => {
            const entry = readSessionRowEntry(row);
            row.sharingEntry = entry;
            if (entry?.archivedAt !== undefined && !registryFactsReady) {
              return archive.deferAcquisition(row);
            }
            return acquireEntry(row, entry);
          });
          if (!admitted || isCold(admitted)) {
            continue;
          }
          dirty.add(records.identity(admitted));
          backfill.enqueue(records.identity(admitted));
        }
      }
    }
    // Dirty keys retain failed background work for the next reader.
    void ensureMaterialized().catch(() => {});
  }
  const { readSourceEntry, readChildLinks } = createSessionRowRelationReads({
    config: () => cfg,
    rows,
    byParent,
    dirty,
    referenced,
    readEntry: readSessionRowEntry,
    acquireEntry,
  });
  function materialize(
    row: records.Row,
    configuredAgentIds = new Set(listAgentIds(cfg)),
    readRow = readResidentSessionRow,
    databaseFacts?: PreparedSessionRowDatabaseFacts,
  ) {
    if (!row.entry) {
      return false;
    }
    const links = readChildLinks(row, databaseFacts !== undefined);
    if (!isIncognitoSessionKey(row.key)) {
      row.membership = new Set(membership.membership(row.storeTarget.storePath, row.key) ?? []);
    }
    const prepared = readRow({
      row: { ...row, entry: row.entry },
      cfg,
      modelCatalog: catalog.current,
      configuredAgentIds,
      context: metadata.current,
      subagentInputs: metadata.subagentInputs,
      gatewayContext: params.context,
      placementFactsReader: placementFacts,
      links,
      readSourceEntry: (key) => readSourceEntry(row, key, databaseFacts !== undefined),
      databaseFacts,
    });
    if (!isIncognitoSessionKey(row.key) && rows.get(records.identity(row)) !== row) {
      return false;
    }
    if (!isIncognitoSessionKey(row.key)) {
      placementFacts.register(row.entry.sessionId);
    }
    revisionToken = undefined;
    Object.assign(row, prepared, {
      materializedSequence: ++materializedCount,
      ...metadata.materializedRevisions,
    });
    return true;
  }
  const {
    refresh,
    refreshBatch,
    prepareExactRows,
    assertExactRowsPrepared,
    dispose: disposeRefresh,
  } = createSessionRowRefresh({
    rows,
    dirty,
    state: () => ({
      cfg,
      disposed,
      topologyDirty,
    }),
    runAsOwner: inOwnerContext,
    lookup,
    prepareRegistryFacts,
    topology,
    catalog,
    placementFacts,
    membership,
    prepare: () => {
      metadata.prepare(epoch, cfg, matching, put);
      return cfg;
    },
    revision: () => epoch,
    databaseRevision: () => databaseRevision,
    acquireEntry,
    readEntry: readSessionRowEntry,
    materialize,
    forgetBackfill: backfill.remove,
    retainArchived(row) {
      // Exact preparation participates in the archive owner's existing bounded cache.
      archive.describe(row);
      backfill.enqueue(records.identity(row));
    },
  });
  function needsMaterialization() {
    return (
      !disposed &&
      (topologyDirty ||
        catalog.needsInitialRead ||
        dirty.size > 0 ||
        membership.needsPreparation ||
        placementFacts.needsPreparation ||
        !inOwnerContext(() => metadata.readPrepared(epoch)))
    );
  }
  const transcriptUpdates = createSessionRowProjectionTranscriptUpdates({
    matching,
    mark,
    read: (id) => rows.get(id),
    refresh(id) {
      const row = rows.get(id);
      if (!row || (isCold(row) && !row.pendingDatabaseFacts)) {
        return;
      }
      epoch++;
      databaseRevision++;
      revisionToken = undefined;
      row.pendingDatabaseFacts = undefined;
      dirty.add(id);
      backfill.enqueue(id);
      void ensureMaterialized().catch(() => {});
    },
  });
  const stop = [
    retainUserProfileCatalog(),
    sessionChanges.subscribeFacts(membership.invalidate),
    sessionChanges.subscribeProjection(mark),
    onSessionLifecycleEvent(mark),
    onSessionIdentityMutation((mutation) => {
      for (const key of mutation.previous.sessionKeys) {
        for (const row of matching({ key, agentId: mutation.agentId })) {
          if (mutation.previous.sessionId && row.entry?.sessionId !== mutation.previous.sessionId) {
            continue;
          }
          markRelated(row);
          if ("current" in mutation && mutation.current.sessionKeys.includes(row.key)) {
            put(records.renewGeneration(row));
            dirty.add(records.identity(row));
          } else {
            remove(records.identity(row));
          }
        }
      }
      if ("current" in mutation) {
        for (const sessionKey of mutation.current.sessionKeys) {
          mark({ agentId: mutation.agentId, sessionKey });
        }
      } else {
        void ensureMaterialized().catch(() => {});
      }
    }),
  ];
  function isCurrent(row: records.Row) {
    const current = isIncognitoSessionKey(row.key)
      ? lookup({ ...row, storePath: row.storeTarget.storePath })
      : rows.get(records.identity(row));
    return records.isCurrentGeneration(row, current);
  }
  function prepareRead() {
    if (topologyDirty) {
      inOwnerContext(topology);
    }
    metadata.prepare(epoch, cfg, matching, put);
  }
  const describe = (query: records.Lookup, captured?: records.Row) =>
    inOwnerContext(() => {
      if (disposed) {
        return undefined;
      }
      prepareRead();
      let row = lookup(query);
      if (row && isIncognitoSessionKey(row.key)) {
        materialize(row);
      } else {
        if (row && dirty.has(records.identity(row))) {
          // Keyed reads refresh only their owner; unrelated bulk work never gates a response.
          const id = records.identity(row);
          refresh([id]);
          row = lookup(query);
        }
        row = archive.describe(row);
      }
      if (captured && !isCurrent(captured)) {
        return undefined;
      }
      if (!records.ready(row)) {
        return undefined;
      }
      metadata.preparePresentation(row, readChildLinks);
      return row;
    });
  function dispose() {
    revisionToken = undefined;
    disposed = true;
    disposeRefresh();
    catalog.dispose();
    membership.dispose();
    placementFacts.dispose();
    transcriptUpdates.dispose();
    backfill.dispose();
    for (const unsubscribe of stop) {
      unsubscribe();
    }
    for (const map of [rows, stores, byStore, byAgent, byParent, byKey, dirty]) {
      map.clear();
    }
    creators.dispose();
    archive.clear();
  }
  function selectEntries(query: records.Query = {}) {
    if (disposed) {
      return [];
    }
    return inOwnerContext(() => {
      prepareRead();
      return withAgentRosterFactsBatch(cfg, () =>
        selectSessionRowEntries(
          {
            cfg,
            scope,
            byAgent,
            byParent,
            rows,
            dirty,
            matching,
            acquire: (row) => acquireEntry(row, readSessionRowEntry(row)),
          },
          query,
        ),
      );
    });
  }
  await inOwnerContext(async () => {
    await ensureSessionGroupCatalog();
    await refreshBatch();
  }).catch((error: unknown) => {
    dispose();
    throw error;
  });
  void ensureMaterialized().catch(() => {});
  backfill.start();
  const { needsExactMembershipPreparation, ...membershipRead } =
    createSessionRowMembershipReadAccess({
      membership,
      runInOwner: inOwnerContext,
      isActive: () => !disposed,
      topologyDirty: () => topologyDirty,
      topology,
      lookup,
      owner: (): SessionRowReadView & { isCurrent: typeof isCurrent } => projection,
    });
  const projection = {
    readPreparedRowContext: () =>
      disposed ? undefined : inOwnerContext(() => metadata.readPrepared(epoch)),
    capture(query: records.Lookup) {
      if (!disposed && topologyDirty) {
        inOwnerContext(topology);
      }
      const row = lookup(query);
      return row && dirty.has(records.identity(row))
        ? (acquireEntry(row, readSessionRowEntry(row)) ?? row)
        : row;
    },
    findBySessionId(query: Parameters<typeof findSessionRowById>[0]) {
      if (!disposed && topologyDirty) {
        inOwnerContext(topology);
      }
      return findSessionRowById(query, { disposed, lookup, matching });
    },
    describe,
    ...createSessionRowAncestorReads({
      state: () => ({ cfg, context: metadata.current }),
      referenced,
      lookup,
      prepareExactRows,
      assertExactRowsPrepared,
      retainArchiveRows: archive.retainRows,
      describe,
      inOwnerContext,
      placementFacts,
      membership: {
        prepare: membershipRead.prepareMembership,
        needsPreparation: needsExactMembershipPreparation,
      },
      isActive: () => !disposed,
      projection: (): SessionRowReadView & { isCurrent(row: records.Row): boolean } => projection,
    }),
    setArchivePageSize: archive.setPageSize,
    modelFacts(row: records.EntryRow) {
      return readSessionRowModelFacts({
        cfg,
        ...row,
        preparedAcpMeta:
          row.materialized && !dirty.has(records.identity(row))
            ? (row.materialized.source.thinkingProjection.acpMeta ?? null)
            : undefined,
        source: { entry: row.storedEntry, readSourceEntry: (key) => readSourceEntry(row, key) },
        modelCatalog: catalog.current,
        rowContext: metadata.current,
      });
    },
    present: (record: records.MaterializedRow, options?: records.SnapshotOptions) =>
      records.present(record, metadata.current, options),
    ensureMaterialized,
    ...membershipRead,
    get materializedCount() {
      return materializedCount;
    },
    get dirtyRowCount() {
      return dirty.size;
    },
    get needsMaterialization() {
      return needsMaterialization();
    },
    get state() {
      if (!disposed) {
        prepareRead();
      }
      return {
        // Include replacements and lifecycle-only removals as well as publications/materialization.
        revision: (revisionToken ??= {}),
        cfg,
        modelCatalog: catalog.current,
        rowContext: metadata.current,
        scope: scope.select,
      };
    },
    isCurrent,
    selectEntries,
    listCreatedActors: (): ReturnType<typeof creators.list> =>
      inOwnerContext(() => creators.list(projection.state.scope({}).paths, matching)),
    snapshot: (query: records.Lookup, options: records.SnapshotOptions = {}) =>
      records.snapshot(describe(query), metadata.current, options),
    dispose,
  };
  return projection;
}

export type SessionRowProjection = Awaited<ReturnType<typeof createSessionRowProjection>>;
