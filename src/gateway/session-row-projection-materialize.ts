import { performance } from "node:perf_hooks";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { readPreparedSessionEntryChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import { readCommittedSessionEntryCache } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { resolveSessionKeyBySessionId } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readCommittedIncognitoSessionSharing } from "../config/sessions/session-accessor.sqlite-incognito-sharing.js";
import { projectSqliteSessionParticipants } from "../config/sessions/session-accessor.sqlite-participant-projection.js";
import { listSessionMembers } from "../config/sessions/session-sharing-store.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  listOpenIncognitoAgentDatabases,
} from "../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import { readPreparedGatewayModelMetadata } from "./server-model-catalog-view.js";
import { readSessionRowModelFacts } from "./session-row-model-facts.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import * as records from "./session-row-projection-record.js";
import type { prepareSessionRowScopes } from "./session-row-scope.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { deriveSessionTitle, type SessionChildLink } from "./session-utils-core.js";
import { materializeSessionRow, readSessionRowInputs } from "./session-utils-row.js";
import { createGatewaySessionEntryReader } from "./session-utils-store-lineage.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";

/** Apply committed metadata before observers without reacquiring it from SQLite. */
export function createSessionRowPublication(owner: {
  store: (path: string) => records.SessionRowStore | undefined;
  runAsOwner: <T>(run: () => T) => T;
  registryFactsReady: () => boolean;
  acquireEntry: (row: records.Row, entry: records.Row["storedEntry"]) => records.Row | undefined;
  markRelated: (row: records.Row, includeChildren: boolean) => void;
  invalidatePlacement: (sessionId: string) => void;
  invalidateFacts: (row: records.Row, domain: true | "category") => boolean;
  enqueue: (row: records.Row | undefined) => void;
  defer: (row: records.Row) => void;
  deferArchive: (row: records.Row) => void;
  remove: (id: string) => void;
}) {
  function acquirePublishedEntry(row: records.Row, entry: NonNullable<records.Row["storedEntry"]>) {
    owner.markRelated(row, records.changesSessionRowDependents(row.storedEntry, entry));
    owner.runAsOwner(() => {
      if (entry.archivedAt !== undefined && !owner.registryFactsReady()) {
        // Retain committed metadata while the independent lineage owner recovers.
        const previous = row.storedEntry ?? row.entry;
        const changedIdentity =
          previous &&
          (previous.sessionId !== entry.sessionId ||
            previous.lifecycleRevision !== entry.lifecycleRevision);
        owner.deferArchive({
          ...(changedIdentity ? records.renewGeneration(row) : row),
          publishedSource: row.publishedSource,
          storedEntry: entry,
          sharingEntry: entry,
        });
        return;
      }
      owner.enqueue(owner.acquireEntry(row, entry));
    });
  }
  return function publish(
    row: records.Row,
    change: Extract<SessionRowChange, { sessionKey: string }>,
    prepared = readPreparedSessionEntryChange(change, row.key),
  ) {
    const source = prepared?.source;
    const previousSource = row.publishedSource;
    if (
      source &&
      previousSource?.incarnation === source.incarnation &&
      previousSource.revision !== undefined &&
      source.revision !== undefined &&
      previousSource.revision > source.revision
    ) {
      return;
    }
    const store = owner.store(row.storeTarget.storePath);
    if (
      prepared &&
      (!source ||
        store?.identity !== source.identity ||
        store.birthtime !== source.birthtime ||
        store.filename !== source.filename)
    ) {
      return;
    }
    const facts = change.facts;
    const sharingUnchanged =
      !change.factsInvalidated &&
      (facts?.kind === "unchanged" ||
        (!change.storePath && !facts && change.scope !== "session-entry"));
    if (facts?.kind === "removed") {
      owner.remove(records.identity(row));
      return;
    }
    if (prepared && !prepared.entry && !prepared.sharing) {
      return;
    }
    records.invalidateDatabaseFacts(row);
    if (
      !prepared &&
      !change.factsInvalidated &&
      facts?.kind === "owner" &&
      row.sharingEntry?.sessionId === facts.sessionId &&
      (row.sharingEntry.lifecycleRevision ?? null) === facts.lifecycleRevision
    ) {
      const { owner: _previousOwner, ...entry } = row.sharingEntry;
      const next = freezeJsonSnapshot({
        ...entry,
        ...(facts.owner ? { owner: structuredClone(facts.owner) } : {}),
      });
      if (row.sharingEntry === row.storedEntry) {
        acquirePublishedEntry(row, next);
      } else {
        owner.defer({ ...row, sharingEntry: next });
      }
      return;
    }
    if (!prepared && !sharingUnchanged) {
      row.publishedSource = undefined;
    }
    if (
      !prepared?.entry &&
      change.factsInvalidated &&
      owner.invalidateFacts(row, change.factsInvalidated)
    ) {
      // Category uncertainty cannot retire an otherwise current row identity.
      owner.defer(row);
      return;
    }
    if (row.entry && change.scope !== "session-entry") {
      owner.invalidatePlacement(row.entry.sessionId);
    }
    if (prepared?.entry) {
      acquirePublishedEntry(
        {
          ...row,
          publishedSource: prepared.source,
          unresolvedDatabaseFacts: undefined,
        },
        prepared.entry,
      );
      return;
    }
    if (prepared?.sharing) {
      const sharing = prepared.sharing;
      const next =
        row.entry?.sessionId !== sharing.sessionId ||
        row.entry.lifecycleRevision !== sharing.lifecycleRevision
          ? records.renewGeneration(row)
          : { ...row };
      next.publishedSource = prepared.source;
      next.sharingEntry = sharing;
      if (sharing.archivedAt !== undefined && !owner.registryFactsReady()) {
        owner.deferArchive(next);
      } else {
        owner.defer(next);
      }
      return;
    }
    if (
      !sharingUnchanged &&
      (!facts ||
        facts.kind === "entry" ||
        change.factsInvalidated ||
        (facts.kind === "owner" &&
          (row.sharingEntry?.sessionId !== facts.sessionId ||
            (row.sharingEntry.lifecycleRevision ?? null) !== facts.lifecycleRevision)) ||
        ((facts.kind === "member" || facts.kind === "category") &&
          row.sharingEntry?.sessionId !== facts.sessionId))
    ) {
      row.sharingEntry = undefined;
    }
    owner.defer(row);
  };
}

/** Bind live projection state to the same prepared or resident source-read boundary. */
export function createSessionRowModelFactsReader(params: {
  lookup: (query: records.Lookup) => records.Row | undefined;
  readSourceEntry: (row: records.Row, key: string, prepared: boolean) => records.Row["storedEntry"];
  state: () => Pick<
    Parameters<typeof readSessionRowModelFacts>[0],
    "cfg" | "modelCatalog" | "rowContext"
  >;
}) {
  return (query: records.Lookup, metadataPrepared = false) => {
    const row = params.lookup(query);
    if (!row?.entry) {
      throw new Error("Session changed while preparing search facts; retry the request");
    }
    const state = params.state();
    return readSessionRowModelFacts({
      ...state,
      ...row,
      preparedModelMetadata: readPreparedGatewayModelMetadata(state.cfg),
      source: {
        entry: row.storedEntry,
        readSourceEntry: (key) => params.readSourceEntry(row, key, metadataPrepared),
      },
    });
  };
}

/** Exact descriptions use the projection's custody and materialization owners in one frame. */
export function createSessionRowDescriptionReader(owner: {
  runInOwner: <T>(consume: () => T) => T;
  prepare: () => boolean;
  lookup: (query: records.Lookup) => records.Row | undefined;
  dirty: ReadonlySet<string>;
  refresh: (ids: string[]) => void;
  describeArchived: (row: records.Row | undefined) => records.Row | undefined;
  isCurrent: (row: records.Row) => boolean;
  materializePrivate: (
    row: records.Row,
    repositoryWorkspace?: Readonly<SessionRepositoryWorkspaceRecord> | null,
  ) => void;
  preparePresentation: (row: records.MaterializedRow) => void;
}) {
  return (
    query: records.Lookup,
    captured?: records.Row,
    repositoryWorkspace?: Readonly<SessionRepositoryWorkspaceRecord> | null,
  ) =>
    owner.runInOwner(() => {
      if (!owner.prepare()) {
        return undefined;
      }
      let row = owner.lookup(query);
      if (row && isIncognitoSessionKey(row.key)) {
        owner.materializePrivate(row, repositoryWorkspace);
      } else {
        if (row && owner.dirty.has(records.identity(row))) {
          // Keyed reads refresh only their owner; unrelated bulk work never gates a response.
          owner.refresh([records.identity(row)]);
          row = owner.lookup(query);
        }
        row = owner.describeArchived(row);
      }
      if (captured && !owner.isCurrent(captured)) {
        return undefined;
      }
      if (!records.ready(row)) {
        return undefined;
      }
      owner.preparePresentation(row);
      return row;
    });
}

/** One synchronous refresh slice shares agent policy; each later slice starts fresh. */
function createSessionRowMaterializationBatch(): typeof readResidentSessionRow {
  const activitySummaryEnabledByAgent = new Map<string, boolean>();
  return (params) => readResidentSessionRow(params, activitySummaryEnabledByAgent);
}

/** Keyed and worker-prepared refreshes share the same bounded materialization slice. */
export function createSessionRowMaterializer(owner: {
  isActive: () => boolean;
  rows: ReadonlyMap<string, records.Row>;
  dirty: Set<string>;
  prepare: () => records.Inputs["cfg"];
  revision: () => number;
  acquireEntry: (row: records.Row, entry: records.Row["storedEntry"]) => records.Row | undefined;
  readEntry: (row: records.Row) => records.Row["storedEntry"];
  materialize: (
    row: records.Row,
    agentIds: Set<string>,
    read: typeof readResidentSessionRow,
    facts?: records.PreparedSessionRowDatabaseFacts,
  ) => boolean;
  forgetBackfill: (id: string) => void;
  retainArchived: (row: records.MaterializedRow) => void;
}) {
  function refresh(ids: readonly string[], accepted = false) {
    if (!owner.isActive()) {
      return;
    }
    const started = performance.now();
    const cfg = owner.prepare();
    withAgentRosterFactsBatch(cfg, () => {
      const configuredAgentIds = new Set(listAgentIds(cfg));
      const readRow = createSessionRowMaterializationBatch();
      for (const [offset, id] of ids.entries()) {
        if (offset > 0 && performance.now() - started >= 12) {
          break;
        }
        const current = owner.rows.get(id),
          revision = owner.revision();
        const databaseFacts = accepted ? current?.pendingDatabaseFacts : undefined;
        if (accepted && !databaseFacts) {
          continue;
        }
        if (!accepted && current?.unresolvedDatabaseFacts === "category") {
          continue;
        }
        const row =
          current && (accepted ? current : owner.acquireEntry(current, owner.readEntry(current)));
        if (row && isColdArchivedSessionRow(row) && !accepted) {
          owner.dirty.delete(id);
          owner.forgetBackfill(id);
          continue;
        }
        if (
          row &&
          owner.materialize(row, configuredAgentIds, readRow, databaseFacts) &&
          owner.revision() === revision
        ) {
          row.pendingDatabaseFacts = undefined;
          owner.dirty.delete(id);
          // A bulk slice may finish an exact read's accepted archive row. Keep its
          // residency under the archive owner's pins and bounded cache either way.
          if (accepted && records.ready(row) && row.entry.archivedAt !== undefined) {
            owner.retainArchived(row);
          }
        }
        if (owner.revision() !== revision) {
          break;
        }
      }
    });
  }
  return {
    refresh,
    refreshPending(this: void, ids: readonly string[]) {
      const pending = ids.filter((id) => owner.rows.get(id)?.pendingDatabaseFacts);
      if (pending.length === 0) {
        return false;
      }
      refresh(pending, true);
      return true;
    },
    accept(
      ids: readonly string[],
      facts: ReadonlyMap<string, records.PreparedSessionRowDatabaseFacts>,
      options: { archived?: boolean; materialize?: boolean } = {},
    ) {
      if (!owner.isActive()) {
        return;
      }
      const cfg = owner.prepare();
      const revision = owner.revision();
      withAgentRosterFactsBatch(cfg, () => {
        for (const id of ids) {
          const current = owner.rows.get(id);
          const databaseFacts = facts.get(id);
          const row =
            current &&
            owner.acquireEntry(
              databaseFacts
                ? {
                    ...current,
                    hasBoard: databaseFacts.hasBoard,
                    unresolvedDatabaseFacts: undefined,
                  }
                : current,
              databaseFacts?.entry,
            );
          if (owner.revision() !== revision) {
            break;
          }
          if (row && databaseFacts) {
            row.preparedAcpMeta = databaseFacts.acpMeta;
          }
          if (row && isColdArchivedSessionRow(row) && !options.archived) {
            owner.dirty.delete(id);
            owner.forgetBackfill(id);
          } else if (row) {
            row.pendingDatabaseFacts = databaseFacts;
            row.retainedDatabaseFacts = databaseFacts;
          }
        }
      });
      if (options.materialize !== false) {
        refresh(ids, true);
      }
    },
  };
}

/** Resident rows consume committed metadata; optional transcript work has a separate budget. */
export function readResidentSessionRow(
  params: {
    row: records.Row & { entry: NonNullable<records.Row["entry"]> };
    cfg: records.Inputs["cfg"];
    modelCatalog: records.Inputs["modelCatalog"];
    configuredAgentIds: ReadonlySet<string>;
    context: SessionListRowContext;
    subagentInputs: SessionListRowContext["subagentRuns"]["inputs"];
    gatewayContext: Parameters<typeof readSessionRowFacts>[0]["context"];
    placementFactsReader?: Parameters<typeof readSessionRowFacts>[0]["placementFactsReader"];
    links: SessionChildLink[];
    readSourceEntry: (key: string) => records.Row["storedEntry"];
    databaseFacts?: records.PreparedSessionRowDatabaseFacts;
    repositoryWorkspace?: Readonly<SessionRepositoryWorkspaceRecord> | null;
  },
  activitySummaryEnabledByAgent?: Map<string, boolean>,
) {
  const { row, cfg, context } = params;
  row.privateSource?.assertCurrent();
  const prepared = row.preparedPrivate;
  const databaseFacts = params.databaseFacts ?? prepared?.databaseFacts;
  const source =
    isIncognitoSessionKey(row.key) && !prepared
      ? resolveGatewaySessionStoreTargetWithStore({
          cfg,
          key: row.key,
          agentId: row.agentId,
          exactRead: true,
          projection: "list",
          includeStoreChildEntries: true,
        })
      : undefined;
  const { inputs, presentation } = readSessionRowInputs({
    ...row,
    cfg,
    preparedAcpMeta: databaseFacts ? databaseFacts.acpMeta : row.preparedAcpMeta,
    preparedModelMetadata: readPreparedGatewayModelMetadata(cfg),
    preparedRepositoryWorkspace: databaseFacts
      ? databaseFacts.repositoryWorkspace
      : params.repositoryWorkspace,
    configuredAgentIds: params.configuredAgentIds,
    store: prepared?.entries ?? source?.store ?? {},
    storePath: row.storeTarget.storePath,
    storeAgentId: row.storeTarget.agentId,
    // Cache stored fallback facts independently of the live activity chosen at presentation.
    active: source ? undefined : false,
    activeModel: source ? undefined : (row.fallbackModel ?? null),
    modelCatalog: params.modelCatalog,
    modelSource: {
      entry: row.storedEntry,
      readSourceEntry: prepared
        ? (key) => prepared.entries[key]
        : source
          ? createGatewaySessionEntryReader({ cfg, ...source })
          : params.readSourceEntry,
    },
    rowContext: context,
    // Incognito rows are transient exact reads and never enter the resident backfill queue.
    includeDerivedTitles: Boolean(source),
    includeLastMessage: Boolean(source),
    skipTranscriptUsageFallback: true,
    includeSwarmChildren: true,
    childLinks: source || prepared ? undefined : params.links,
  });
  if (!source) {
    inputs.derivedTitle = deriveSessionTitle(row.entry, undefined, inputs.displayName);
    inputs.lastMessagePreview = row.lastMessagePreview;
  }
  inputs.subagentRunInputs = params.subagentInputs;
  const materialized = materializeSessionRow(inputs);
  // Row preparation may populate the metadata used by automatic utility policy.
  let activitySummaryEnabled: boolean | undefined;
  if (activitySummaryEnabledByAgent && row.entry.sessionId && !row.entry.initializationPending) {
    activitySummaryEnabled = activitySummaryEnabledByAgent.get(row.agentId);
    if (activitySummaryEnabled === undefined) {
      activitySummaryEnabled = Boolean(
        resolveUtilityModelRefForAgent({ cfg, agentId: row.agentId }),
      );
      activitySummaryEnabledByAgent.set(row.agentId, activitySummaryEnabled);
    }
  }
  const facts = readSessionRowFacts({
    cfg,
    target: row,
    entry: row.entry,
    context: params.gatewayContext,
    placementFactsReader: params.placementFactsReader,
    activitySummaryEnabled,
    databaseFacts,
  });
  row.privateSource?.assertCurrent();
  return {
    materialized,
    preparedAcpMeta: materialized.source.thinkingProjection.acpMeta ?? null,
    fallbackModel: presentation.activeModel,
    facts,
    hasBoard: facts.hasBoard,
    membership: source
      ? new Set(
          listSessionMembers({ ...row.storeTarget, sessionKey: row.key }).map(
            (member) => member.identityId,
          ),
        )
      : row.membership,
  };
}

export function readSessionRowEntry(row: records.Row) {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const cache = readCommittedSessionEntryCache(database.db);
      const cached = cache?.get(row.key);
      const entry = cache
        ? cached && projectSqliteSessionParticipants(database.db, row.key, cached)
        : readExactSessionEntryRow(database, row.key, "list")?.entry;
      if (entry && isIncognitoSessionKey(row.key)) {
        row.generation = readOpenClawAgentDatabaseIdentity(database).identity;
        row.privateSource = {
          identity: row.generation,
          assertCurrent() {
            if (
              !database.db.isOpen ||
              getOpenClawAgentDatabaseIfOpen({
                agentId: database.agentId,
                path: database.path,
              })?.db !== database.db
            ) {
              throw new Error("Private session database changed during its read");
            }
            const current = readCommittedIncognitoSessionSharing(database.db, row.key)?.entry;
            if (
              current?.sessionId !== entry.sessionId ||
              current.lifecycleRevision !== entry.lifecycleRevision
            ) {
              throw new Error("Private session changed during its read");
            }
          },
        };
      }
      return entry;
    },
    { agentId: row.storeTarget.agentId, path: row.storeTarget.storePath },
  );
  return result.found ? result.value : undefined;
}

/** Exact incognito acquisition never admits an ephemeral store to the resident roster. */
function readIncognitoSessionRow(params: {
  cfg: records.Inputs["cfg"];
  key: string;
  agentId: string;
}) {
  const { cfg, key, agentId } = params;
  const ephemeralPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
  if (!listOpenIncognitoAgentDatabases().some((store) => store.storePath === ephemeralPath)) {
    return undefined;
  }
  const row = records.create({ key, agentId, storeTarget: { agentId, storePath: ephemeralPath } });
  const storedEntry = readSessionRowEntry(row);
  if (!storedEntry || !row.privateSource) {
    return undefined;
  }
  return records.createIncognitoSessionRow({
    cfg,
    key,
    agentId,
    storePath: ephemeralPath,
    entry: storedEntry,
    source: row.privateSource,
  });
}

/** Resident identities use indexes; private identities remain exact process-local reads. */
export function findSessionRowById(
  query: { sessionId: string; agentId?: string; storePath?: string; federated?: boolean },
  owner: {
    disposed: boolean;
    lookup: (query: records.Lookup) => records.Row | undefined;
    matching: (query: records.Query, kind?: string) => records.Row[];
    scope: ReturnType<typeof prepareSessionRowScopes>;
  },
): records.Row[] {
  if (owner.disposed) {
    return [];
  }
  if (
    query.agentId &&
    query.storePath &&
    isIncognitoOpenClawAgentSqlitePath(query.storePath, { agentId: query.agentId })
  ) {
    const key = resolveSessionKeyBySessionId(query);
    if (!key || (query.federated && isInternalSessionEffectsKey(key))) {
      return [];
    }
    const row = owner.lookup({ ...query, agentId: query.agentId, key });
    return row?.entry?.sessionId === query.sessionId &&
      (!query.federated || row.entry.incognito === true)
      ? [row]
      : [];
  }
  const candidates = owner.matching({ ...query, key: query.sessionId }, "id");
  if (!query.federated) {
    return candidates;
  }
  // Select each key's physical winner before matching its ID. A shadowed row
  // must not resurrect an old run mapping that the combined store would hide.
  const selected = candidates.length
    ? [...new Set(candidates.map((row) => row.key))].flatMap((key) => {
        const paths = owner.scope.select(query).paths;
        const row = records.first(
          owner
            .matching({ ...query, key })
            .filter((candidate) => paths.has(candidate.storeTarget.storePath)),
          paths.keys(),
        );
        return row?.entry?.sessionId === query.sessionId ? [row] : [];
      })
    : [];
  // Process-held private stores keep their existing exact native reader;
  // private rows never enter the resident index or a new cache.
  for (const store of listOpenIncognitoAgentDatabases()) {
    if (
      (!query.agentId || query.agentId === store.agentId) &&
      (!query.storePath || query.storePath === store.storePath)
    ) {
      selected.push(...findSessionRowById({ ...query, ...store }, owner));
    }
  }
  return selected;
}

export function lookupSessionRow(
  query: records.Lookup,
  owner: {
    disposed: boolean;
    cfg: records.Inputs["cfg"];
    matching: (query: records.Query) => records.Row[];
    storePaths: Iterable<string>;
  },
) {
  if (owner.disposed) {
    return undefined;
  }
  const { agentId } = query;
  const exact = owner.matching(query).filter((row) => row.agentId === agentId);
  if (exact.length) {
    return records.first(exact, owner.storePaths);
  }
  const key = resolveStoredSessionKeyForAgentStore({
    cfg: owner.cfg,
    sessionKey: query.key,
    agentId,
  });
  if (isIncognitoSessionKey(key)) {
    return readIncognitoSessionRow({ cfg: owner.cfg, key, agentId });
  }
  const candidates = owner.matching({ ...query, key }).filter((row) => row.agentId === agentId);
  return records.first(candidates, owner.storePaths);
}
