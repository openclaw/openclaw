import { AsyncLocalStorage } from "node:async_hooks";
import type { readPreparedSessionEntryChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  isSessionStoreTopologyChange,
  type SessionRowChange,
} from "../sessions/session-row-changes.js";
import { isOpenClawAgentDatabaseRegistryChange } from "../state/openclaw-agent-db-registry-listing.js";
import * as profiles from "../state/user-profile-list.js";
import { ensureSessionGroupCatalog } from "./session-group-catalog.js";
import { createSessionMembershipProjection } from "./session-membership-projection.js";
import { createSessionProjectionDrain, yieldSessionListWork } from "./session-projection-work.js";
import * as rowMembership from "./session-row-membership-read.js";
import { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import type { readPreparedSessionRows } from "./session-row-prepared-read.js";
import * as rowRelations from "./session-row-projection-ancestors.js";
import {
  createSessionRowProjectionArchive,
  isColdArchivedSessionRow as isCold,
} from "./session-row-projection-archive.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import { createSessionRowProjectionCatalog } from "./session-row-projection-catalog.js";
import { createSessionRowProjectionContext } from "./session-row-projection-context.js";
import { createSessionRowGenerationMutations } from "./session-row-projection-generation.js";
import {
  createSessionRowCreatorIndex,
  indexSessionRow,
} from "./session-row-projection-identities.js";
import * as rowReads from "./session-row-projection-materialize.js";
import {
  createSessionRowPublication,
  subscribeSessionRowPublications,
} from "./session-row-projection-publication.js";
import { createSessionRowRecents } from "./session-row-projection-recents.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowRefresh } from "./session-row-projection-refresh.js";
import { createSessionRowProjectionRevisions } from "./session-row-projection-revisions.js";
import {
  createSessionRowTopology,
  prepareSessionRowTopologySources,
} from "./session-row-projection-topology.js";
import { createSessionRowProjectionTranscriptUpdates } from "./session-row-projection-transcript.js";
import * as rowScope from "./session-row-scope.js";
import { replaceSessionRowFacts } from "./session-utils-row.js";

/** Committed publications own invalidation; each admitted physical store is hydrated once. */
export async function createSessionRowProjection(params: records.ProjectionOptions) {
  // Publications may borrow startup admission; projection work retains its own authority.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const { env, profileCatalogPath, discoveryRead, subagents } =
    await prepareSessionRowTopologySources();
  let cfg = params.getConfig?.() ?? params.cfg;
  const getPolicyConfig = () => params.getPolicyConfig?.() ?? params.getConfig?.() ?? cfg;
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
  const recents = createSessionRowRecents({
    rows,
    state: () => ({ cfg, scope, context: metadata.current }),
    refresh: () => ({ prepareSelection, selectionNeedsPreparation }),
    assertActive: () => assertActive(),
  });
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
  const revisions = createSessionRowProjectionRevisions(rows, byKey);
  let materializedCount = 0;
  let scope: ReturnType<typeof rowScope.prepareSessionRowScopes>;
  const ensureMaterialized = createSessionProjectionDrain({
    beforeEnsure() {
      if (!disposed && !catalog.needsInitialRead) {
        void inOwnerContext(() => catalog.refresh());
      }
    },
    hasWork: () => needsMaterialization(),
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
    onRefreshed(changedAgents) {
      if (!changedAgents || changedAgents.size > 0) {
        epoch++;
        revisions.invalidate();
        revisions.publishFacts();
        metadata.invalidate({ all: true, scope: "catalog" });
        archive.invalidateRows(
          { all: true, scope: "catalog", runtimeOwnershipChanged: true },
          changedAgents
            ? [...changedAgents].flatMap((agentId) => matching({ agentId }))
            : rows.values(),
        );
      }
      void ensureMaterialized().catch(() => {});
    },
  });
  const metadata = createSessionRowProjectionContext(subagents);
  const backfill = createSessionRowProjectionBackfill({
    ready: ensureMaterialized,
    read: (id) => rows.get(id),
    current: isCurrent,
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
      recents.track(row);
    },
  });
  const markRelated = (row: records.Row, includeChildren = true) =>
    archive.markRelated(row, indexes, includeChildren);
  function remove(id: string) {
    archive.forget(id);
    transcriptUpdates.remove(id);
    const row = rows.get(id);
    if (row) {
      recents.update(row, true);
      rowFacts.track(row, undefined);
      revisions.invalidate(true);
      invalidateRowMembership(row);
      markRelated(row);
      creators.update(row);
      indexSessionRow(row, indexes, true);
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
      indexSessionRow(previous, indexes, true);
    }
    rows.set(records.identity(row), row);
    recents.update(row);
    rowFacts.track(row, row.unresolvedDatabaseFacts);
    indexSessionRow(row, indexes);
    placementFacts.update(row, previous, (sessionId) =>
      [...(byKey.get(`id:${sessionId}`) ?? [])].flatMap((id) => rows.get(id) ?? []),
    );
    // Index updates are synchronous; publish only after the accepted row is installed.
    revisions.replace(previous, row);
  }
  function acquireEntry(row: records.Row, storedEntry: records.Row["storedEntry"]) {
    if (storedEntry?.archivedAt !== undefined) {
      inOwnerContext(() => metadata.prepare(epoch, cfg, matching, put, referenced));
    }
    return records.acquireSessionRowEntry({
      row,
      rows,
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
  const assertActive = () => {
    if (disposed) {
      throw new Error("Session row projection is no longer active");
    }
  };
  const lookup = (query: records.Lookup) =>
    disposed
      ? undefined
      : rowReads.lookupSessionRow(query, cfg, rows, byKey, scope, stores, assertActive);
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
    placement: placementFacts,
    invalidateFacts: (row, domain) => {
      const categoryOnly = rowFacts.invalidate(row, domain);
      recents.track(row);
      return categoryOnly;
    },
    enqueue,
    defer(row) {
      put(row);
      enqueue(row);
    },
    deferArchive: (row) => archive.deferAcquisition(row),
    remove,
  });
  const topology = createSessionRowTopology({
    env,
    profileCatalogPath,
    discovery: discoveryRead,
    run: inOwnerContext,
    state: () => ({ cfg, stores, disposed, dirty: topologyDirty, epoch }),
    config: () => params.getConfig?.() ?? cfg,
    rows,
    byStore,
    byAgent,
    createStoreRead,
    remove,
    put,
    acquire(row, entry) {
      enqueue(acquireEntry(row, entry));
      markRelated(row);
    },
    setConfig(next) {
      cfg = next;
    },
    setStores(next) {
      stores = next;
    },
    publish(nextScope) {
      scope = nextScope;
      recents.reset();
      revisions.publishSelection();
      // Config changes during this read are picked up by a subsequent publication.
      topologyDirty = false;
    },
    prepareExactRows: (queries) => prepareExactRows(queries),
  });
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
      (change.scope === "config-presentation" || change.scope === "config-profiles")
    ) {
      cfg = inOwnerContext(() => params.getConfig?.() ?? cfg);
    }
    epoch++;
    const identityRevision = metadata.current.identityProjection?.revision;
    const catalogOnly = "all" in change && change.scope === "catalog" && !change.factsInvalidated;
    // Catalog adoption invalidates model facts only when its completed policy changes.
    const presentationOnly =
      !(catalogOnly && params.getModelCatalog) &&
      metadata.invalidate(change) &&
      !change.factsInvalidated;
    revisions.publishRuntimeChange(change);
    if (!presentationOnly || metadata.current.identityProjection?.revision !== identityRevision) {
      revisions.invalidate(!catalogOnly);
    }
    placementFacts.invalidateChange(change);
    if ("all" in change) {
      if (isSessionStoreTopologyChange(change) || change.scope === "config") {
        topologyDirty = true;
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
    } else if (!change.factsInvalidated && (change.scope === "automation" || presentationOnly)) {
      const affected = matching({ key: change.sessionKey }).filter((row) => !isCold(row));
      for (const row of affected) {
        if (change.agentId && row.agentId !== change.agentId) {
          continue;
        }
        const id = records.identity(row);
        // Runtime summary state does not change the entry-derived materialization.
        if (presentationOnly && row.facts) {
          row.facts.refreshActivitySummary();
        } else {
          dirty.add(id);
        }
      }
    } else if (!presentationOnly) {
      rowScope.visitSessionRowPublicationTargets(change, {
        matching,
        scope,
        stores,
        publish: (row) => {
          if (change.scope === "transcript" || change.factsInvalidated === true) {
            backfill.remove(records.identity(row));
          }
          revisions.withChangeScope(change.scope, () => markStoredRow(row, change, prepared));
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
      assertCurrent: assertActive,
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
    readRow = rowReads.readResidentSessionRow,
    preparedDatabaseFacts?: records.PreparedSessionRowDatabaseFacts,
    repositoryWorkspace?: records.Inputs["preparedRepositoryWorkspace"],
  ) {
    const retained = row.retainedDatabaseFacts;
    const databaseFacts =
      preparedDatabaseFacts ??
      (records.isPreparedSessionRowDatabaseFacts(retained) ? retained : undefined);
    if (!records.hasEntry(row) || (!databaseFacts && !isIncognitoSessionKey(row.key))) {
      return false;
    }
    const links = readChildLinks(row, databaseFacts !== undefined);
    const prepared = readRow({
      row,
      membership: isIncognitoSessionKey(row.key)
        ? undefined
        : (membership.membership(row.storeTarget.storePath, row.key) ?? []),
      cfg,
      modelCatalog: catalog.current,
      configuredAgentIds: metadata.configuredAgentIds,
      revisions: metadata.materializedRevisions,
      context: metadata.current,
      subagentInputs: metadata.subagentInputs,
      gatewayContext: params.context,
      placementFactsReader: placementFacts,
      links,
      readSourceEntry: (key) => readSourceEntry(row, key, databaseFacts !== undefined),
      databaseFacts,
      repositoryWorkspace,
    });
    if (!isIncognitoSessionKey(row.key)) {
      placementFacts.register(row.entry.sessionId);
    }
    revisions.materialized(row, {
      ...prepared,
      materializedSequence: ++materializedCount,
      ...metadata.materializedRevisions,
    });
    if (!isIncognitoSessionKey(row.key) && records.ready(row)) {
      backfill.prepare(row, databaseFacts);
    }
    return true;
  }
  const {
    refresh,
    refreshBatch,
    prepareExactRows,
    prepareSelection,
    selectionNeedsPreparation,
    needsMaterialization,
    withSelectionPreparation,
    retainExactPreparation,
    dispose: disposeRefresh,
  } = createSessionRowRefresh({
    rows,
    dirty,
    env,
    state: () => ({
      cfg,
      disposed,
      topologyDirty: topologyDirty || !profiles.isUserProfileCatalogReady(profileCatalogPath),
      registryPrepared: Boolean(inOwnerContext(subagents.snapshotIdentity)),
    }),
    runAsOwner: inOwnerContext,
    lookup,
    prepareRegistryFacts,
    topology,
    catalog,
    placementFacts,
    membership,
    metadataReady: () => Boolean(inOwnerContext(() => metadata.readPrepared(epoch))),
    prepare: () => {
      metadata.prepare(epoch, cfg, matching, put, referenced);
      return cfg;
    },
    acquireEntry,
    materialize,
    forgetBackfill: backfill.remove,
    retainArchived: (row) => archive.describe(row),
  });
  const transcriptUpdates = createSessionRowProjectionTranscriptUpdates({
    matching,
    mark,
    read: (id) => rows.get(id),
    store: (path) => stores.get(path),
    refresh(id, retained) {
      const row = rows.get(id);
      if (!row || (isCold(row) && !row.pendingDatabaseFacts)) {
        return;
      }
      epoch++;
      revisions.invalidate();
      records.invalidateDatabaseFacts(row, retained);
      // Certified transcript facts refresh summaries and previews without replacing the row.
      if (retained && records.ready(row) && !dirty.has(id) && row.facts) {
        row.facts.refreshActivitySummary(retained);
        backfill.prepare(row, retained);
        revisions.publishFacts(row);
        return;
      }
      dirty.add(id);
      revisions.publishFacts(row);
      void ensureMaterialized().catch(() => {});
    },
  });
  const generationMutations = createSessionRowGenerationMutations({
    stores: () => stores,
    matching,
    markRelated,
    put,
    remove,
    dirty,
    mark,
    ensureMaterialized,
  });
  const stop = subscribeSessionRowPublications({
    rows,
    dirty,
    revisions,
    advanceRevision: () => epoch++,
    ensureMaterialized,
    publishTranscript: (change) => transcriptUpdates.publish(change),
    invalidateMembership: membership.invalidate,
    mark,
    mutateGeneration: generationMutations.mutate,
  });
  function isCurrent(row: records.Row) {
    return row.privateSource
      ? records.isPrivateSourceCurrent(row.privateSource)
      : records.isCurrentGeneration(row, rows.get(records.identity(row)));
  }
  function prepareRead() {
    if (topologyDirty || !profiles.isUserProfileCatalogReady(profileCatalogPath)) {
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
    materializePrivate: (row, repository) => materialize(row, undefined, undefined, repository),
    preparePresentation(row) {
      if (row.materialized.source.cfg !== cfg) {
        row.materialized = replaceSessionRowFacts(row.materialized, undefined, { cfg });
      }
      metadata.preparePresentation(row, readChildLinks);
    },
  });
  function dispose() {
    disposed = true;
    revisions.dispose();
    registryRead.dispose();
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
    recents.dispose();
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
      hasUnresolvedCategories: rowFacts.needsPreparation(),
      acquire: (row) =>
        acquireEntry(row, row.retainedDatabaseFacts?.entry ?? readSessionRowEntry(row)),
      referenced,
    }),
  });
  await inOwnerContext(async () => {
    stop.push((await profiles.prepareUserProfileCatalog({ env })).release);
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
      owner: (): Parameters<typeof readPreparedSessionRows>[0] => projection,
      needsRowFactsPreparation: rowFacts.needsPreparation,
      prepareRowFacts: rowFacts.prepare,
    });
  const projection = {
    ...rowReads.createSessionRowLookup({
      assertCurrent: assertActive,
      state: () => ({
        cfg,
        scope,
        stores,
        disposed,
        topologyDirty,
        registryPrepared: !disposed && Boolean(inOwnerContext(subagents.snapshotIdentity)),
      }),
      lookup,
      matching,
      acquireEntry,
      env,
      runInOwner: inOwnerContext,
    }),
    onSelectionChange: revisions.onSelectionChange,
    onFactsChange: revisions.onFactsChange,
    readTaskPublicationRevision: revisions.taskPublication,
    hasLogicalChildEntries: (parent: Pick<records.Row, "agentId" | "key">) =>
      byParent.has(records.logicalSessionRowIdentity(parent.agentId, parent.key)),
    get physicalPaths() {
      return scope.physicalPaths;
    },
    readPreparedRowContext: () =>
      disposed ? undefined : inOwnerContext(() => metadata.readPrepared(epoch)),
    readPreparedSpawnedBy,
    describe,
    ...rowRelations.createSessionRowAncestorReads({
      state: () => ({ cfg, context: metadata.current }),
      referenced,
      lookup,
      prepareExactRows,
      prepareSelection,
      retainExactPreparation,
      retainArchiveRows: archive.retainRows,
      describe,
      inOwnerContext,
      placementFacts,
      membership: {
        prepare: prepareMembershipFacts,
        needsPreparation: needsExactMembershipPreparation,
      },
      isActive: () => !disposed,
      projection: (): Parameters<typeof readPreparedSessionRows>[0] => projection,
    }),
    setArchivePageSize: archive.setPageSize,
    ...rowReads.createSessionRowModelFactsReader({
      rows: () => rows.values(),
      onFactsChange: revisions.onFactsChange,
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
        physicalStorePaths: scope.physicalPaths,
      };
    },
    isCurrent,
    selectEntries,
    projectRecentCandidates: recents.candidates,
    listCreatedActors: (): ReturnType<typeof creators.list> =>
      creators.list(() => projection.state.scope({}).paths, matching),
    snapshot: (query: records.Lookup, options: records.SnapshotOptions = {}) =>
      records.snapshot(describe(query), metadata.current, options),
    dispose,
  };
  return projection;
}

export type SessionRowProjection = Awaited<ReturnType<typeof createSessionRowProjection>>;
