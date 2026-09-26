import { AsyncLocalStorage } from "node:async_hooks";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import {
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentSessionListReadCache,
} from "../agents/subagents/registry/subagent-registry-state.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { resolveStateDir } from "../config/state-dir.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../state/agent-deletion-journal.read.js";
import { retainUserProfileCatalog } from "../state/user-profile-list.js";
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
import { isIdentityScopesOnlyConfigChange } from "./session-row-projection-config.js";
import { createSessionRowProjectionContext } from "./session-row-projection-context.js";
import { createSessionRowGenerationObservations } from "./session-row-projection-generation.js";
import { createSessionRowCreatorIndex } from "./session-row-projection-identities.js";
import {
  lookupSessionRow,
  findSessionRowById,
  readResidentSessionRow,
} from "./session-row-projection-materialize.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowRefresh } from "./session-row-projection-refresh.js";
import { createSessionRowProjectionTranscriptUpdates } from "./session-row-projection-transcript.js";
import {
  createSessionRowScopeMatcher,
  prepareSessionRowScopes,
  selectMatchingSessionRows,
  selectSessionRowEntries,
} from "./session-row-scope.js";

/** Committed publications own invalidation; each admitted physical store is hydrated once. */
export async function createSessionRowProjection(params: records.ProjectionOptions) {
  // Publications may borrow startup admission; projection work retains its own authority.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const discoveryRead = prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime");
  while (!getSubagentSessionListReadSnapshotIdentity()) {
    await prepareSubagentSessionListReadCache();
  }
  let cfg = params.getConfig?.() ?? params.cfg;
  const getPolicyConfig = () => params.getPolicyConfig?.() ?? cfg;
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
  const placementFacts = createSessionRowPlacementProjection(params.placementFactsReader, () =>
    !disposed && topologyDirty ? topology() : prepareRegistryFacts(),
  );
  let epoch = 0;
  let topologyEpoch = 0;
  let preparingTopology: Promise<void> | undefined;
  let databaseRevision = 0;
  // Stored-entry and row-identity changes release weakly held list selections.
  // Live presentation facts do not change the resident roster or its entry tuples.
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
      if (records.ready(current)) {
        // Preview publication changes this live row in place, without replacing selection inputs.
        records.publishTranscriptFields(current, fields, cfg, metadata.current);
      }
    },
  });
  const archive = createSessionRowProjectionArchive({
    rows,
    dirty,
    put,
    config: () => cfg,
    context: () => metadata.current,
    referenced,
    enqueue: (id, change) => backfill.enqueue(id, change),
    release(id) {
      transcriptUpdates.remove(id);
      backfill.remove(id);
      dirty.delete(id);
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
      // Cold dependents reselect only after the removed parent is absent from the inventory.
      markRelated(row);
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
      inOwnerContext(() => metadata.prepare(epoch, cfg, matching, put, referenced));
    }
    return records.acquireSessionRowEntry({
      row,
      storedEntry,
      cfg,
      context: metadata.current,
      referenced,
      remove,
      put,
      markRelated,
      archive,
    });
  }
  const matching = (query: records.Query, kind = "key") =>
    selectMatchingSessionRows({ rows, indexes, scope }, query, kind);
  const lookup = (query: records.Lookup) =>
    lookupSessionRow(query, { disposed, cfg, matching, storePaths: stores.keys() });
  function referenced(ref: string) {
    return records.firstReferenced(ref, rows, byKey, stores.keys());
  }
  function enqueue(row: records.Row | undefined) {
    if (row) {
      const id = records.identity(row);
      dirty.add(id);
      if (!isCold(row)) {
        backfill.enqueue(id);
      }
    }
  }
  function topology(): Promise<void> {
    if (disposed || !topologyDirty) {
      return Promise.resolve();
    }
    return (preparingTopology ??= inOwnerContext(async () => {
      const targetEpoch = topologyEpoch;
      const nextConfig = params.getConfig?.() ?? cfg;
      const prepared = await discoveryRead.readWithCurrentAdmission();
      const topologyCurrent = () =>
        !disposed && topologyEpoch === targetEpoch && (params.getConfig?.() ?? cfg) === nextConfig;
      prepared.assertCurrent();
      if (!topologyCurrent()) {
        return;
      }
      const discovery = { env, snapshot: prepared.snapshot };
      const revision = epoch;
      const storeRead = createStoreRead({ stores, rows, byStore, env });
      const loaded = storeRead.loadCombinedStore(nextConfig, discovery);
      prepared.assertCurrent();
      if (!topologyCurrent()) {
        return;
      }
      cfg = nextConfig;
      const acquisitions = records.seedSessionRowEntries({
        targets: loaded.targetsBySessionKey,
        rows,
        replaced: storeRead.replaced,
        remove,
        put,
      });
      stores = storeRead.sources;
      // Every stored identity must be visible before an earlier store selects a later parent.
      for (const { row, entry } of acquisitions) {
        enqueue(acquireEntry(row, entry));
      }
      storeRead.updateMembership();
      scope = prepareSessionRowScopes(
        cfg,
        byAgent.keys(),
        new Map([...stores].map(([locator, source]) => [source.filename, locator])),
        discovery,
      );
      topologyDirty = epoch !== revision;
    }).finally(() => {
      preparingTopology = undefined;
    }));
  }
  function mark(change: SessionRowChange) {
    if ("all" in change && change.scope === "config") {
      generations.invalidate();
    }
    if ("all" in change && change.scope === "config" && !change.factsInvalidated) {
      const next = inOwnerContext(() => params.getConfig?.() ?? cfg);
      if (isIdentityScopesOnlyConfigChange(cfg, next)) {
        cfg = next;
        void ensureMaterialized().catch(() => {});
        return;
      }
    }
    epoch++;
    const presentationOnly = metadata.invalidate(change) && !change.factsInvalidated;
    if (!presentationOnly) {
      revisionToken = undefined;
    }
    if ("all" in change) {
      const catalogOnly = change.scope === "catalog" && !change.factsInvalidated;
      if (!presentationOnly && !catalogOnly) {
        databaseRevision++;
      }
      placementFacts.invalidateChange(change);
      if (change.scope === "stores" || change.scope === "config") {
        topologyDirty = true;
        topologyEpoch = epoch;
      }
      if (change.scope === "catalog" || change.scope === "config") {
        catalog.invalidate();
      }
      // Renewal serves the old catalog until its replacement is adopted.
      if (!presentationOnly && (!catalogOnly || !params.getModelCatalog)) {
        archive.invalidateRows(
          change,
          typeof change.scope === "string" ? rows.values() : matching(change.scope),
        );
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
        records.invalidateDatabaseFacts(previous);
        if (previous.entry && change.scope !== "session-entry") {
          placementFacts.invalidate(previous.entry.sessionId);
        }
        const row = inOwnerContext(() => {
          const entry = readSessionRowEntry(previous);
          markRelated(previous, records.changesSessionRowDependents(previous.storedEntry, entry));
          previous.sharingEntry = entry;
          if (entry?.archivedAt !== undefined && !registryFactsReady) {
            // Committed row changes must survive an unrelated compact-facts refill.
            return archive.deferAcquisition(previous);
          }
          return isCold(previous) || records.changesRowStructure(previous, entry)
            ? acquireEntry(previous, entry)
            : previous;
        });
        enqueue(row);
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
          enqueue(admitted);
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
    databaseFacts?: records.PreparedSessionRowDatabaseFacts,
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
    retainExactPreparation,
    assertExactRowsPrepared,
    dispose: disposeRefresh,
  } = createSessionRowRefresh({
    rows,
    dirty,
    state: () => ({
      cfg,
      disposed,
      topologyDirty,
      registryPrepared: Boolean(inOwnerContext(getSubagentSessionListReadSnapshotIdentity)),
    }),
    runAsOwner: inOwnerContext,
    lookup,
    prepareRegistryFacts,
    topology,
    catalog,
    placementFacts,
    membership,
    prepare: () => {
      metadata.prepare(epoch, cfg, matching, put, referenced);
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
      revisionToken = undefined;
      records.invalidateDatabaseFacts(row);
      dirty.add(id);
      backfill.enqueue(id);
      void ensureMaterialized().catch(() => {});
    },
  });
  const generations = createSessionRowGenerationObservations({
    config: () => inOwnerContext(() => params.getConfig?.() ?? cfg),
    env,
    isActive: () => !disposed,
    stores: () => stores,
    isCurrent,
    matching,
    markRelated,
    put,
    remove,
    dirty,
    mark,
    ensureMaterialized,
  });
  const stop = [
    retainUserProfileCatalog(),
    sessionChanges.subscribeFacts(membership.invalidate),
    sessionChanges.subscribeProjection(mark),
    onSessionLifecycleEvent(mark),
    onSessionIdentityMutation(generations.mutate),
  ];
  function isCurrent(row: records.Row) {
    const current = isIncognitoSessionKey(row.key)
      ? lookup({ ...row, storePath: row.storeTarget.storePath })
      : rows.get(records.identity(row));
    return records.isCurrentGeneration(row, current);
  }
  function prepareRead() {
    if (topologyDirty) {
      return false;
    }
    metadata.prepare(epoch, cfg, matching, put, referenced);
    return true;
  }
  const describe = (query: records.Lookup, captured?: records.Row) =>
    inOwnerContext(() => {
      if (disposed || !prepareRead()) {
        return undefined;
      }
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
    generations.invalidate();
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
      if (!prepareRead()) {
        throw new Error("Session row topology changed; prepare current facts before reading");
      }
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
            referenced,
          },
          query,
        ),
      );
    });
  }
  await inOwnerContext(async () => {
    await ensureSessionGroupCatalog();
    for (;;) {
      await refreshBatch();
      if (disposed || !topologyDirty) {
        return;
      }
    }
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
      stores: () => stores,
      owner: (): SessionRowReadView & { isCurrent: typeof isCurrent } => projection,
    });
  const projection = {
    observeGeneration: generations.observeGeneration,
    readPreparedRowContext: () =>
      disposed ? undefined : inOwnerContext(() => metadata.readPrepared(epoch)),
    capture(query: records.Lookup) {
      if (disposed) {
        return undefined;
      }
      const row = lookup(query);
      // Queued events retain the last published identity while new topology is preparing.
      return row && !topologyDirty && dirty.has(records.identity(row))
        ? (acquireEntry(row, readSessionRowEntry(row)) ?? row)
        : row;
    },
    findBySessionId(query: Parameters<typeof findSessionRowById>[0]) {
      return findSessionRowById(query, { disposed, lookup, matching });
    },
    describe,
    readMembership(query: records.Lookup) {
      if (disposed) {
        return undefined;
      }
      const row = lookup(query);
      if (row && isIncognitoSessionKey(row.key)) {
        return describe(query)?.membership;
      }
      const members = row && membership.membership(row.storeTarget.storePath, row.key);
      return members ? new Set(members) : undefined;
    },
    ...createSessionRowAncestorReads({
      state: () => ({ cfg, context: metadata.current }),
      referenced,
      lookup,
      prepareExactRows,
      retainExactPreparation,
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
    getPolicyConfig,
    get state() {
      if (!disposed && !prepareRead()) {
        throw new Error("Session row topology changed; prepare current facts before reading");
      }
      return {
        // Include replacements and lifecycle-only removals as well as publications/materialization.
        revision: (revisionToken ??= {}),
        cfg,
        policyConfig: getPolicyConfig(),
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
