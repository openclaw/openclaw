import { performance } from "node:perf_hooks";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { readCommittedSessionEntryCache } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { resolveSessionKeyBySessionId } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readCommittedIncognitoSessionSharing } from "../config/sessions/session-accessor.sqlite-incognito-sharing.js";
import { projectSqliteSessionParticipants } from "../config/sessions/session-accessor.sqlite-participant-projection.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { listSessionMembers } from "../config/sessions/session-sharing-store.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
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
    const binding = memory
      ? undefined
      : captureIncognitoSessionBinding({ ...query, sessionKey: query.key });
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
      memory
        ? runWithSessionActorStorage(memory, describe)
        : binding
          ? withIncognitoSessionBinding(binding, describe)
          : describe(),
    );
  };
}

/** Keyed and worker-prepared refreshes share the same bounded materialization slice. */
export function createSessionRowMaterializer(owner: {
  isActive: () => boolean;
  rows: ReadonlyMap<string, records.Row>;
  dirty: Set<string>;
  prepare: () => records.Inputs["cfg"];
  revision: () => number;
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
        const current = owner.rows.get(id),
          revision = owner.revision();
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
        if (
          row &&
          owner.materialize(row, configuredAgentIds, readRow, databaseFacts) &&
          owner.revision() === revision
        ) {
          row.pendingDatabaseFacts = undefined;
          row.retainedDatabaseFacts = databaseFacts;
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
  if (
    !prepared &&
    isIncognitoSessionKey(row.key) &&
    (getSessionActorStorageBinding({}) ||
      captureIncognitoSessionBinding({ ...row.storeTarget, sessionKey: row.key }))
  ) {
    throw new Error("Incognito session descriptions require awaited row preparation");
  }
  const databaseFacts = params.databaseFacts ?? prepared?.databaseFacts;
  if (!databaseFacts && !isIncognitoSessionKey(row.key)) {
    throw new Error("Durable session rows require prepared database facts");
  }
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
    preparedRuntimeOwnership: databaseFacts
      ? databaseFacts.runtimeOwnership
      : row.preparedRuntimeOwnership,
    preparedModelMetadata: readPreparedGatewayModelMetadata(cfg),
    preparedRepositoryWorkspace: databaseFacts
      ? databaseFacts.repositoryWorkspace
      : params.repositoryWorkspace,
    configuredAgentIds: params.configuredAgentIds,
    store: prepared?.entries ?? source?.store ?? {},
    storePath: row.storeTarget.storePath,
    storeAgentId: row.storeTarget.agentId,
    // Cache stored fallback facts independently of the live activity chosen at presentation.
    active: source || prepared ? undefined : false,
    activeModel: source || prepared ? undefined : (row.fallbackModel ?? null),
    terminalModel: prepared ? (prepared.terminalModel ?? null) : undefined,
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
    inputs.derivedTitle = deriveSessionTitle(
      row.entry,
      prepared?.titleFields?.firstUserMessage ?? undefined,
      inputs.displayName,
    );
    inputs.lastMessagePreview = prepared?.titleFields?.lastMessagePreview ?? row.lastMessagePreview;
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
  const memory = captureSessionActorStorageOwner({ ...row.storeTarget, sessionKey: row.key });
  if (memory && isIncognitoSessionKey(row.key)) {
    return memory.owner?.readSession(row.key, memory.authority)?.entry;
  }
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
  storePath?: string;
}) {
  const { key, agentId, storePath } = params;
  const memory = captureSessionActorStorageOwner({ agentId, sessionKey: key, storePath });
  if (memory) {
    const selected = getSessionActorStorageBinding({});
    const current =
      selected?.actor.target.sessionKey === key
        ? selected.actor.snapshot(memory.authority)
        : memory.owner?.readSession(key, memory.authority);
    if (!current?.entry) {
      return undefined;
    }
    return records.createIncognitoSessionRow({
      ...params,
      storePath: memory.path,
      entry: current.entry,
      membership: new Set(current.members.map((member) => member.identityId)),
      source: {
        identity: current.version.epoch,
        assertCurrent() {
          selected?.actor.assertReadable();
          memory.authority.assertCurrent();
        },
      },
    });
  }
  const binding = captureIncognitoSessionBinding({ agentId, sessionKey: key, storePath });
  if (binding) {
    const { actor } = binding;
    const entry = actor.sessions.readSharing(key)?.entry;
    if (!entry) {
      return undefined;
    }
    const snapshot = actor.sessions.captureSnapshot(key);
    return records.createIncognitoSessionRow({
      ...params,
      storePath: actor.path,
      entry,
      source: {
        identity: actor.identity.incarnation,
        assertCurrent() {
          binding.admissionSignal?.throwIfAborted();
          actor.assertReadable();
          snapshot.assertCurrent();
        },
      },
    });
  }
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
    ...params,
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
  const memory = captureSessionActorStorageOwner(query);
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
  const privateBinding =
    !memory && query.agentId && query.storePath ? captureIncognitoSessionBinding(query) : undefined;
  if (
    query.agentId &&
    query.storePath &&
    (privateBinding ||
      isIncognitoOpenClawAgentSqlitePath(query.storePath, { agentId: query.agentId }))
  ) {
    const key = privateBinding
      ? privateBinding.actor.sessions.deadlines().find((fact) => fact.sessionId === query.sessionId)
          ?.sessionKey
      : resolveSessionKeyBySessionId(query);
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
  // Process-held private stores keep their existing exact native reader;
  // private rows never enter the resident index or a new cache.
  const binding = memory ? undefined : captureIncognitoSessionBinding();
  const privateStores = memory
    ? [{ agentId: memory.agentId, storePath: memory.path }]
    : binding
      ? [{ agentId: binding.actor.agentId, storePath: binding.actor.path }]
      : listOpenIncognitoAgentDatabases();
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
      return readIncognitoSessionRow({ cfg: owner.cfg, key, agentId, storePath: query.storePath });
    }
  } while (key !== query.key);
  return undefined;
}
