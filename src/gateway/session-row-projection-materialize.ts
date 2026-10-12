import { performance } from "node:perf_hooks";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { readCommittedSessionEntryCache } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { projectSqliteSessionParticipants } from "../config/sessions/session-accessor.sqlite-participant-projection.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import { readPreparedGatewayModelMetadata } from "./server-model-catalog-view.js";
import { readSessionRowModelFacts } from "./session-row-model-facts.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import * as records from "./session-row-projection-record.js";
import { readSessionRowLookup, type prepareSessionRowScopes } from "./session-row-scope.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { deriveSessionTitle, type SessionChildLink } from "./session-utils-core.js";
import { materializeSessionRow, readSessionRowInputs } from "./session-utils-row.js";

/** Bind live projection state to the same prepared or resident source-read boundary. */
export function createSessionRowModelFactsReader(params: {
  lookup: (query: records.Lookup) => records.Row | undefined;
  dirty: ReadonlySet<string>;
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
    if (records.ready(row) && !params.dirty.has(records.identity(row))) {
      return row.materialized.source;
    }
    if (row.preparedRuntimeOwnership === undefined) {
      throw new Error("Native session ownership must be prepared before reading search facts");
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
  ) => {
    const memory = getSessionActorStorageBinding({});
    const describe = () => {
      if (!owner.prepare()) {
        return undefined;
      }
      if (
        captured?.preparedPrivate &&
        (captured.key !== query.key ||
          captured.agentId !== query.agentId ||
          (query.storePath !== undefined && captured.storeTarget.storePath !== query.storePath))
      ) {
        return undefined;
      }
      let row = captured?.preparedPrivate ? captured : owner.lookup(query);
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
    };
    return owner.runInOwner(() =>
      memory ? runWithSessionActorStorage(memory, describe) : describe(),
    );
  };
}

/** Keyed and worker-prepared refreshes share the same bounded materialization slice. */
export function createSessionRowMaterializer(owner: {
  isActive: () => boolean;
  rows: ReadonlyMap<string, records.Row>;
  dirty: Set<string>;
  prepare: () => records.Inputs["cfg"];
  acquireEntry: (row: records.Row, entry: records.Row["storedEntry"]) => records.Row | undefined;
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
      const activitySummaryEnabledByAgent = new Map<string, boolean>();
      const readRow: typeof readResidentSessionRow = (params) =>
        readResidentSessionRow(params, activitySummaryEnabledByAgent);
      for (const [offset, id] of ids.entries()) {
        if (offset > 0 && performance.now() - started >= 12) {
          break;
        }
        const current = owner.rows.get(id);
        const databaseFacts = accepted
          ? current?.pendingDatabaseFacts
          : current?.retainedDatabaseFacts;
        if (!records.isPreparedSessionRowDatabaseFacts(databaseFacts)) {
          continue;
        }
        if (!accepted && !records.canRetainSessionRowRuntimeOwnership(databaseFacts)) {
          continue;
        }
        if (!accepted && current?.unresolvedDatabaseFacts === "category") {
          continue;
        }
        const row =
          current && (accepted ? current : owner.acquireEntry(current, databaseFacts.entry));
        if (row && isColdArchivedSessionRow(row) && !accepted) {
          owner.dirty.delete(id);
          owner.forgetBackfill(id);
          continue;
        }
        if (row && owner.materialize(row, configuredAgentIds, readRow, databaseFacts)) {
          row.pendingDatabaseFacts = undefined;
          row.retainedDatabaseFacts = databaseFacts;
          owner.dirty.delete(id);
          // A bulk slice may finish an exact read's accepted archive row. Keep its
          // residency under the archive owner's pins and bounded cache either way.
          if (accepted && records.ready(row) && row.entry.archivedAt !== undefined) {
            owner.retainArchived(row);
          }
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
          if (row && databaseFacts) {
            row.preparedAcpMeta = databaseFacts.acpMeta;
            row.preparedRuntimeOwnership = databaseFacts.runtimeOwnership;
            row.runtimeOwnershipDependencies = databaseFacts.runtimeOwnershipDependencies;
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
  if (!prepared && isIncognitoSessionKey(row.key)) {
    throw new Error("Incognito session descriptions require awaited row preparation");
  }
  const databaseFacts = params.databaseFacts ?? prepared?.databaseFacts;
  if (!databaseFacts) {
    throw new Error("Session rows require prepared database facts");
  }
  const { inputs, presentation } = readSessionRowInputs({
    ...row,
    cfg,
    preparedAcpMeta: databaseFacts.acpMeta,
    preparedRuntimeOwnership: databaseFacts.runtimeOwnership,
    preparedModelMetadata: readPreparedGatewayModelMetadata(cfg),
    preparedRepositoryWorkspace: databaseFacts.repositoryWorkspace,
    configuredAgentIds: params.configuredAgentIds,
    store: prepared?.entries ?? {},
    storePath: row.storeTarget.storePath,
    storeAgentId: row.storeTarget.agentId,
    // Cache stored fallback facts independently of the live activity chosen at presentation.
    active: prepared ? undefined : false,
    activeModel: prepared ? undefined : (row.fallbackModel ?? null),
    terminalModel: prepared ? (prepared.terminalModel ?? null) : undefined,
    modelCatalog: params.modelCatalog,
    modelSource: {
      entry: row.storedEntry,
      readSourceEntry: prepared ? (key) => prepared.entries[key] : params.readSourceEntry,
    },
    rowContext: context,
    // Incognito rows are transient exact reads and never enter the resident backfill queue.
    includeDerivedTitles: false,
    includeLastMessage: false,
    skipTranscriptUsageFallback: true,
    includeSwarmChildren: true,
    childLinks: prepared ? undefined : params.links,
  });
  inputs.derivedTitle = deriveSessionTitle(
    row.entry,
    prepared?.titleFields?.firstUserMessage ?? undefined,
    inputs.displayName,
  );
  inputs.lastMessagePreview = prepared?.titleFields?.lastMessagePreview ?? row.lastMessagePreview;
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
    membership: row.membership,
  };
}

export function readSessionRowEntry(row: records.Row) {
  if (isIncognitoSessionKey(row.key)) {
    const source = row.privateSource;
    if (!source) {
      throw new Error("Incognito session rows require their actor source");
    }
    const memory = captureSessionActorStorageOwner(
      { ...row.storeTarget, sessionKey: row.key },
      {
        assertCurrent: () => source.assertCurrent(),
        authorize: () => source.assertCurrent(),
      },
    );
    return memory?.owner?.readSession(row.key, memory.authority)?.entry;
  }
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const cache = readCommittedSessionEntryCache(database.db);
      const cached = cache?.get(row.key);
      const entry = cache
        ? cached && projectSqliteSessionParticipants(database.db, row.key, cached)
        : readExactSessionEntryRow(database, row.key, "list")?.entry;
      return entry;
    },
    { agentId: row.storeTarget.agentId, path: row.storeTarget.storePath },
  );
  return result.found ? result.value : undefined;
}

/** Exact incognito acquisition never admits an ephemeral store to the resident roster. */
function readIncognitoSessionRow(params: {
  assertCurrent: () => void;
  cfg: records.Inputs["cfg"];
  key: string;
  agentId: string;
  storePath?: string;
}) {
  const { key, agentId, storePath } = params;
  const memory = captureSessionActorStorageOwner(
    { agentId, sessionKey: key, storePath },
    { assertCurrent: params.assertCurrent, authorize: params.assertCurrent },
  );
  const current = memory?.owner?.readSession(key, memory.authority);
  if (!current?.entry || !memory) {
    return undefined;
  }
  const assertSessionCurrent = memory.owner?.captureSessionReadGuard(key);
  return records.createIncognitoSessionRow({
    ...params,
    storePath: memory.path,
    entry: current.entry,
    membership: new Set(current.members.map((member) => member.identityId)),
    source: {
      identity: current.version.epoch,
      assertCurrent() {
        assertSessionCurrent?.();
        memory.binding?.actor.assertReadable();
        memory.authority.assertCurrent();
      },
    },
  });
}

/** Bind discovery and resident identity reads to the projection's current owner. */
export function createSessionRowLookup(owner: {
  assertCurrent: () => void;
  state: () => {
    cfg: records.Inputs["cfg"];
    scope: ReturnType<typeof prepareSessionRowScopes>;
    stores: ReadonlyMap<string, records.SessionRowStore>;
    disposed: boolean;
    topologyDirty: boolean;
    registryPrepared: boolean;
  };
  lookup: (query: records.Lookup) => records.Row | undefined;
  matching: (query: records.Query, kind?: string) => records.Row[];
  acquireEntry: (
    row: records.Row,
    storedEntry: records.Row["storedEntry"],
  ) => records.Row | undefined;
  env: NodeJS.ProcessEnv;
  runInOwner: <T>(consume: () => T) => T;
}) {
  return {
    async readLookup(selection: Parameters<typeof readSessionRowLookup>[0], agentId?: string) {
      const selected = owner.state();
      const queries = await owner.runInOwner(() =>
        readSessionRowLookup(selection, {
          agentId: selected.scope.select({ agentId }).agentId,
          env: owner.env,
          stores: selected.stores,
          paths: selected.scope.select({ agentId }).paths,
          matching: owner.matching,
        }),
      );
      return {
        queries,
        isCurrent: () => {
          const current = owner.state();
          return (
            !current.disposed &&
            !current.topologyDirty &&
            current.scope === selected.scope &&
            current.cfg === selected.cfg
          );
        },
      };
    },
    capture(query: records.Lookup) {
      const row = owner.lookup(query);
      const state = owner.state();
      // Capture retains published identity while category facts wait for reconciliation.
      return row &&
        row.unresolvedDatabaseFacts !== "category" &&
        !state.topologyDirty &&
        !row.entry &&
        row.storedEntry !== undefined &&
        row.unresolvedDatabaseFacts !== true &&
        state.registryPrepared
        ? (owner.acquireEntry(row, row.storedEntry) ?? row)
        : row;
    },
    findBySessionId(query: Parameters<typeof findSessionRowById>[0]) {
      const { disposed, scope } = owner.state();
      return findSessionRowById(query, {
        disposed,
        assertCurrent: owner.assertCurrent,
        scope,
        lookup: owner.lookup,
        matching: owner.matching,
      });
    },
  };
}

/** Resident identities use indexes; private identities remain exact process-local reads. */
function findSessionRowById(
  query: { sessionId: string; agentId?: string; storePath?: string; federated?: boolean },
  owner: {
    disposed: boolean;
    assertCurrent: () => void;
    lookup: (query: records.Lookup) => records.Row | undefined;
    matching: (query: records.Query, kind?: string) => records.Row[];
    scope: ReturnType<typeof prepareSessionRowScopes>;
  },
): records.Row[] {
  if (owner.disposed) {
    return [];
  }
  const memory = captureSessionActorStorageOwner(query, {
    assertCurrent: owner.assertCurrent,
    authorize: owner.assertCurrent,
  });
  if (
    memory &&
    query.agentId &&
    query.storePath &&
    isIncognitoOpenClawAgentSqlitePath(query.storePath, { agentId: query.agentId })
  ) {
    const snapshot = memory.owner
      ?.listSessions(memory.authority)
      .find((current) => current.entry?.sessionId === query.sessionId);
    const key = snapshot?.target.sessionKey;
    if (!key || (query.federated && isInternalSessionEffectsKey(key))) {
      return [];
    }
    const row = owner.lookup({ ...query, agentId: memory.agentId, key });
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
  const selected = [...new Set(candidates.map((row) => row.key))].flatMap((key) => {
    const paths = owner.scope.select(query).paths;
    const row = records.first(
      owner
        .matching({ ...query, key })
        .filter((candidate) => paths.has(candidate.storeTarget.storePath)),
      paths.keys(),
    );
    return row?.entry?.sessionId === query.sessionId ? [row] : [];
  });
  // Private identities stay in the memory owner and never enter the resident index.
  const privateStores = memory
    ? [{ agentId: memory.agentId, storePath: memory.path }]
    : memorySessionActorOwners
        .list()
        .map((memoryOwner) => ({ agentId: memoryOwner.agentId, storePath: memoryOwner.path }));
  for (const store of privateStores) {
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
    assertCurrent: () => void;
    cfg: records.Inputs["cfg"];
    rows: ReadonlyMap<string, records.Row>;
    byKey: ReadonlyMap<string, ReadonlySet<string>>;
    scope: ReturnType<typeof prepareSessionRowScopes> | undefined;
    stores: ReadonlyMap<string, records.SessionRowStore>;
  },
) {
  const { agentId } = query;
  const paths = query.storePath
    ? (owner.scope?.physicalPaths(query.storePath, agentId) ?? [query.storePath])
    : undefined;
  let key = query.key;
  do {
    const candidates = owner.byKey.get(`key:${key}`);
    if (candidates) {
      for (const storePath of paths ?? owner.stores.keys()) {
        for (const id of candidates) {
          const row = owner.rows.get(id);
          if (row?.agentId === agentId && row.storeTarget.storePath === storePath) {
            return row;
          }
        }
      }
    }
    if (key !== query.key) {
      break;
    }
    key = resolveStoredSessionKeyForAgentStore({
      cfg: owner.cfg,
      sessionKey: key,
      agentId,
    });
    if (isIncognitoSessionKey(key)) {
      return readIncognitoSessionRow({
        assertCurrent: owner.assertCurrent,
        cfg: owner.cfg,
        key,
        agentId,
        storePath: query.storePath,
      });
    }
  } while (key !== query.key);
  return undefined;
}
