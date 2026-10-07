import { AsyncLocalStorage } from "node:async_hooks";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { createSubagentSessionListReadView } from "../agents/subagents/registry/subagent-registry-state.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { readPreparedSessionEntryChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { resolveStateDir } from "../config/state-dir.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import {
  sessionChanges,
  isSessionStoreTopologyChange,
  type SessionRowChange,
} from "../sessions/session-row-changes.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../state/agent-deletion-journal.read.js";
import { isOpenClawAgentDatabaseRegistryChange } from "../state/openclaw-agent-db-registry-listing.js";
import { prepareUserProfileCatalog, retainUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureSessionGroupCatalog } from "./session-group-catalog.js";
import { createSessionMembershipProjection } from "./session-membership-projection.js";
import { createSessionProjectionDrain, yieldSessionListWork } from "./session-projection-work.js";
import * as rowMembership from "./session-row-membership-read.js";
import { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import * as rowRelations from "./session-row-projection-ancestors.js";
import {
  createSessionRowProjectionArchive,
  isColdArchivedSessionRow as isCold,
} from "./session-row-projection-archive.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import { createSessionRowProjectionCatalog } from "./session-row-projection-catalog.js";
import { createSessionRowProjectionContext } from "./session-row-projection-context.js";
import { createSessionRowGenerationObservations } from "./session-row-projection-generation.js";
import { createSessionRowCreatorIndex } from "./session-row-projection-identities.js";
import * as rowReads from "./session-row-projection-materialize.js";
import { createSessionRowPublication } from "./session-row-projection-publication.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowRefresh } from "./session-row-projection-refresh.js";
import { createSessionRowProjectionRevisions } from "./session-row-projection-revisions.js";
import { createSessionRowProjectionTranscriptUpdates } from "./session-row-projection-transcript.js";
import * as rowScope from "./session-row-scope.js";

/** Committed publications own invalidation; each admitted physical store is hydrated once. */
export async function createSessionRowProjection(params: records.ProjectionOptions) {
  // Publications may borrow startup admission; projection work retains its own authority.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const discoveryRead = prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime");
  const subagents = createSubagentSessionListReadView({ env });
  while (!subagents.snapshotIdentity()) {
    await subagents.prepare();
  }
  let cfg = params.getConfig?.() ?? params.cfg;
  const getPolicyConfig = () => params.getPolicyConfig?.() ?? cfg;
  const rows = new Map<string, records.Row>();
  const creators = createSessionRowCreatorIndex();
  const membership = createSessionMembershipProjection();
  const { invalidateRowMembership, readSessionRowEntry, createStoreRead } =
    rowMembership.createSessionRowEntryReadAccess(membership);
  let stores = new Map<string, records.SessionRowStore>();
  const byStore = new Map<string, Set<string>>(),
    byAgent = new Map<string, Set<string>>();
  const byParent = new Map<string, Set<string>>(),
    byKey = new Map<string, Set<string>>();
  const indexes = { byStore, byAgent, byParent, byKey };
  const dirty = new Set<string>();
  const rowFacts = rowMembership.createSessionRowFactsReadiness(rows, () => projection);
  let topologyDirty = true,
    disposed = false;
  const registryRead = rowScope.createSessionRowRegistryRead({
    env,
    stores: () => stores,
    isActive: () => !disposed && !topologyDirty,
    runAsOwner: inOwnerContext,
  });
  const prepareRegistryFacts = (): Promise<void> | undefined =>
    disposed
      ? undefined
      : !inOwnerContext(subagents.snapshotIdentity)
        ? inOwnerContext(subagents.prepare)
        : registryRead.prepare();
  const placementFacts = createSessionRowPlacementProjection(
    params.placementFactsReader,
    () => (!disposed && topologyDirty ? topology() : prepareRegistryFacts()),
    env,
  );
  let epoch = 0;
  let topologyEpoch = 0;
  let preparingTopology: Promise<void> | undefined;
  let databaseRevision = 0;
  const revisions = createSessionRowProjectionRevisions(rows, byKey);
  let materializedCount = 0;
  let scope: ReturnType<typeof rowScope.prepareSessionRowScopes>;
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
        revisions.invalidate();
        revisions.publishFacts();
        metadata.invalidate({ all: true, scope: "catalog" });
        archive.invalidateRows({ all: true, scope: "catalog" }, rows.values());
      }
      void ensureMaterialized().catch(() => {});
    },
  });
  const metadata = createSessionRowProjectionContext(subagents);
  const backfill = createSessionRowProjectionBackfill({
    ready: ensureMaterialized,
    read: (id) => rows.get(id),
    current: (row) => !topologyDirty && records.ready(row) && isCurrent(row),
    publish: (row, fields) => revisions.publishTranscript(row, fields, cfg, metadata.current),
  });
  const archive = createSessionRowProjectionArchive({
    rows,
    dirty,
    put,
    config: () => cfg,
    context: () => metadata.current,
    referenced,
    invalidateTranscript: backfill.remove,
    release(id) {
      transcriptUpdates.remove(id);
      backfill.remove(id);
      dirty.delete(id);
    },
    invalidateFacts(row) {
      row.publishedSource = undefined;
      rowFacts.invalidate(row, true);
    },
  });
  const markRelated = (row: records.Row, includeChildren = true) =>
    archive.markRelated(row, indexes, includeChildren);
  function remove(id: string) {
    archive.forget(id);
    transcriptUpdates.remove(id);
    const row = rows.get(id);
    if (row) {
      rowFacts.track(row, undefined);
      revisions.invalidate(true);
      invalidateRowMembership(row);
      markRelated(row);
      creators.update(row);
      records.index(row, indexes, true);
      rows.delete(id);
      revisions.publishFacts(row);
      revisions.publishSelection(row, true);
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
    const previous = rows.get(records.identity(row));
    creators.update(previous, row);
    if (previous) {
      if (previous.generation !== row.generation) {
        transcriptUpdates.remove(records.identity(row));
      }
      records.index(previous, indexes, true);
    }
    rows.set(records.identity(row), row);
    rowFacts.track(row, row.unresolvedDatabaseFacts);
    records.index(row, indexes);
    placementFacts.update(row, previous, (sessionId) =>
      [...(byKey.get(`id:${sessionId}`) ?? [])].flatMap((id) => rows.get(id) ?? []),
    );
    // Index updates are synchronous; publish only after the accepted row is installed.
    revisions.replace(previous, row);
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
    rowScope.selectMatchingSessionRows({ rows, indexes, scope }, query, kind);
  const lookup = (query: records.Lookup) =>
    disposed ? undefined : rowReads.lookupSessionRow(query, { cfg, rows, byKey, scope, stores });
  function referenced(ref: string) {
    return records.firstReferenced(ref, rows, byKey, stores.keys());
  }
  function enqueue(row: records.Row | undefined) {
    if (row) {
      dirty.add(records.identity(row));
    }
  }
  const markStoredRow = createSessionRowPublication({
    store: (path) => stores.get(path),
    runAsOwner: inOwnerContext,
    registryFactsReady: () => Boolean(inOwnerContext(subagents.snapshotIdentity)),
    acquireEntry,
    markRelated,
    invalidatePlacement: (sessionId) => placementFacts.invalidate(sessionId),
    invalidateFacts: (row, domain) => rowFacts.invalidate(row, domain),
    enqueue,
    defer(row) {
      put(row);
      enqueue(row);
    },
    deferArchive: (row) => archive.deferAcquisition(row),
    remove,
  });
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
      await storeRead.loadCombinedStore(nextConfig, discovery, (load) => {
        prepared.assertCurrent();
        if (!topologyCurrent() || epoch !== revision) {
          return;
        }
        const loaded = load();
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
          markRelated(row);
        }
        storeRead.updateMembership();
        scope = rowScope.prepareSessionRowScopes(
          cfg,
          byAgent.keys(),
          new Map([...stores].map(([locator, source]) => [source.filename, locator])),
          discovery,
        );
        revisions.publishSelection();
        topologyDirty = epoch !== revision;
      });
    }).finally(() => {
      preparingTopology = undefined;
    }));
  }
  function mark(
    original: SessionRowChange,
    prepared?: ReturnType<typeof readPreparedSessionEntryChange>,
  ) {
    if (
      isSessionStoreTopologyChange(original) &&
      isOpenClawAgentDatabaseRegistryChange(original) &&
      registryRead.isCurrent()
    ) {
      return;
    }
    const change = rowFacts.conservativeChange(
      original,
      (path) => scope?.physicalPaths(path) ?? [path],
    );
    if (change !== original) {
      // The original broad fence reached compact membership as well as display rows.
      membership.invalidate(change);
    }
    if (
      "all" in change &&
      (change.scope === "config" ||
        change.scope === "config-presentation" ||
        change.scope === "config-profiles")
    ) {
      generations.invalidate();
      if (change.scope !== "config") {
        cfg = inOwnerContext(() => params.getConfig?.() ?? cfg);
      }
    }
    epoch++;
    const presentationOnly = metadata.invalidate(change) && !change.factsInvalidated;
    const catalogOnly = "all" in change && change.scope === "catalog" && !change.factsInvalidated;
    revisions.publishRuntimeChange(change);
    if (!presentationOnly) {
      revisions.invalidate(!catalogOnly);
    }
    placementFacts.invalidateChange(change);
    if ("all" in change) {
      if (!presentationOnly && !catalogOnly) {
        databaseRevision++;
      }
      if (isSessionStoreTopologyChange(change) || change.scope === "config") {
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
      rowScope.visitSessionRowPublicationTargets(change, {
        matching,
        scope,
        stores,
        publish: (row) => {
          if (change.scope === "transcript" || change.factsInvalidated === true) {
            backfill.remove(records.identity(row));
          }
          markStoredRow(row, change, prepared);
        },
      });
    }
    // Dirty keys retain failed background work for the next reader.
    void ensureMaterialized().catch(() => {});
  }
  const { readSourceEntry, readChildLinks, readPreparedSpawnedBy } =
    rowRelations.createSessionRowRelationReads({
      env,
      inOwnerContext,
      isReady: () => !disposed && !topologyDirty,
      preparedContext: () => metadata.readPrepared(epoch),
      lookup,
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
    readRow = rowReads.readResidentSessionRow,
    preparedDatabaseFacts?: records.PreparedSessionRowDatabaseFacts,
    repositoryWorkspace?: Parameters<
      typeof rowReads.readResidentSessionRow
    >[0]["repositoryWorkspace"],
  ) {
    const retained = row.retainedDatabaseFacts;
    const databaseFacts =
      preparedDatabaseFacts ??
      (records.isPreparedSessionRowDatabaseFacts(retained) ? retained : undefined);
    if (!row.entry || (!databaseFacts && !isIncognitoSessionKey(row.key))) {
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
      repositoryWorkspace,
    });
    if (!isIncognitoSessionKey(row.key) && rows.get(records.identity(row)) !== row) {
      return false;
    }
    if (!isIncognitoSessionKey(row.key)) {
      placementFacts.register(row.entry.sessionId);
    }
    const previousBoard = row.hasBoard;
    Object.assign(row, prepared, {
      materializedSequence: ++materializedCount,
      ...metadata.materializedRevisions,
    });
    if (!isIncognitoSessionKey(row.key) && records.ready(row)) {
      backfill.prepare(row, databaseFacts);
    }
    revisions.materialized(row, previousBoard);
    return true;
  }
  const {
    refresh,
    refreshBatch,
    prepareExactRows,
    prepareSelection,
    selectionNeedsPreparation,
    withSelectionPreparation,
    retainExactPreparation,
    assertExactRowsPrepared,
    dispose: disposeRefresh,
  } = createSessionRowRefresh({
    rows,
    dirty,
    env,
    state: () => ({
      cfg,
      disposed,
      topologyDirty,
      registryPrepared: Boolean(inOwnerContext(subagents.snapshotIdentity)),
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
    materialize,
    forgetBackfill: backfill.remove,
    retainArchived: (row) => archive.describe(row),
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
    invalidate: backfill.remove,
    refresh(id) {
      const row = rows.get(id);
      if (!row || (isCold(row) && !row.pendingDatabaseFacts)) {
        return;
      }
      epoch++;
      revisions.invalidate();
      revisions.publishFacts(row);
      records.invalidateDatabaseFacts(row);
      dirty.add(id);
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
    // Participant writers publish facts before their display-only lifecycle notice.
    onSessionLifecycleEvent((change) =>
      mark(change.reason === "participants" ? { ...change, facts: { kind: "unchanged" } } : change),
    ),
    onSessionIdentityMutation(generations.mutate),
  ];
  function isCurrent(row: records.Row) {
    return row.privateSource
      ? records.isPrivateSourceCurrent(row.privateSource)
      : records.isCurrentGeneration(row, rows.get(records.identity(row)));
  }
  function prepareRead() {
    if (topologyDirty) {
      return false;
    }
    metadata.prepare(epoch, cfg, matching, put, referenced);
    return true;
  }
  const describe = rowReads.createSessionRowDescriptionReader({
    runInOwner: inOwnerContext,
    prepare: () => !disposed && prepareRead(),
    lookup,
    dirty,
    refresh,
    describeArchived: (row) => archive.describe(row),
    isCurrent,
    materializePrivate: (row, repository) =>
      materialize(row, undefined, undefined, undefined, repository),
    preparePresentation(row) {
      row.materialized.source.cfg = cfg;
      metadata.preparePresentation(row, readChildLinks);
    },
  });
  function dispose() {
    disposed = true;
    revisions.dispose();
    registryRead.dispose();
    generations.invalidate();
    disposeRefresh();
    metadata.dispose();
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
    rowFacts.clear();
    creators.dispose();
    archive.clear();
  }
  const selectEntries = rowScope.createSessionRowEntrySelector({
    isActive: () => !disposed,
    runAsOwner: inOwnerContext,
    prepare: prepareRead,
    state: () => ({
      cfg,
      scope,
      byAgent,
      byParent,
      rows,
      dirty,
      matching,
      acquire: (row) => acquireEntry(row, readSessionRowEntry(row)),
      referenced,
    }),
  });
  await inOwnerContext(async () => {
    (await prepareUserProfileCatalog()).release();
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
  const { needsExactMembershipPreparation, prepareMembershipFacts, ...membershipRead } =
    rowMembership.createSessionRowMembershipReadAccess({
      membership,
      runInOwner: inOwnerContext,
      isActive: () => !disposed,
      topologyDirty: () => topologyDirty,
      topology,
      lookup,
      stores: () => stores,
      owner: (): SessionRowReadView & { isCurrent: typeof isCurrent } => projection,
      needsRowFactsPreparation: rowFacts.needsPreparation,
      prepareRowFacts: rowFacts.prepare,
    });
  const projection = {
    onSelectionChange: revisions.onSelectionChange,
    onFactsChange: revisions.onFactsChange,
    observeGeneration: generations.observeGeneration,
    readPreparedRowContext: () =>
      disposed ? undefined : inOwnerContext(() => metadata.readPrepared(epoch)),
    readPreparedSpawnedBy,
    capture(query: records.Lookup) {
      const row = lookup(query);
      // Capture retains published identity while category facts wait for reconciliation.
      return row &&
        row.unresolvedDatabaseFacts !== "category" &&
        !topologyDirty &&
        !row.entry &&
        row.storedEntry !== undefined &&
        row.unresolvedDatabaseFacts !== true &&
        inOwnerContext(subagents.snapshotIdentity)
        ? (acquireEntry(row, row.storedEntry) ?? row)
        : row;
    },
    findBySessionId(query: Parameters<typeof rowReads.findSessionRowById>[0]) {
      return rowReads.findSessionRowById(query, { disposed, lookup, matching, scope });
    },
    describe,
    ...rowRelations.createSessionRowAncestorReads({
      state: () => ({ cfg, context: metadata.current }),
      referenced,
      lookup,
      prepareExactRows,
      prepareSelection,
      retainExactPreparation,
      assertExactRowsPrepared,
      retainArchiveRows: archive.retainRows,
      describe,
      inOwnerContext,
      placementFacts,
      membership: {
        prepare: prepareMembershipFacts,
        needsPreparation: needsExactMembershipPreparation,
      },
      isActive: () => !disposed,
      projection: (): SessionRowReadView & {
        isCurrent(row: records.Row): boolean;
        getPolicyConfig: typeof getPolicyConfig;
      } => projection,
    }),
    setArchivePageSize: archive.setPageSize,
    modelFacts: rowReads.createSessionRowModelFactsReader({
      lookup,
      dirty,
      readSourceEntry,
      state: () => ({ cfg, modelCatalog: catalog.current, rowContext: metadata.current }),
    }),
    present: (record: records.MaterializedRow, options?: records.SnapshotOptions) =>
      records.present(record, metadata.current, options),
    ensureMaterialized,
    prepareSelection,
    withSelectionPreparation,
    needsSelectionPreparation: selectionNeedsPreparation,
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
    get sharingRevision() {
      return disposed || topologyDirty ? undefined : revisions.sharing();
    },
    get state() {
      if (!disposed && !prepareRead()) {
        throw new Error("Session row topology changed; prepare current facts before reading");
      }
      return {
        // Selection owns metadata; sharing separately fences every row publication.
        revision: revisions.selection(),
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
      creators.list(() => projection.state.scope({}).paths, matching),
    snapshot: (query: records.Lookup, options: records.SnapshotOptions = {}) =>
      records.snapshot(describe(query), metadata.current, options),
    dispose,
  };
  return projection;
}

export type SessionRowProjection = Awaited<ReturnType<typeof createSessionRowProjection>>;
