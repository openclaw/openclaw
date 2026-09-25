import { performance } from "node:perf_hooks";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { getSubagentSessionListReadSnapshotIdentity } from "../agents/subagents/registry/subagent-registry-state.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { projectGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import { readPreparedSessionEntryChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import { readCommittedSessionEntryCache } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { resolveSessionKeyBySessionId } from "../config/sessions/session-accessor.sqlite-entry.js";
import { projectSqliteSessionParticipants } from "../config/sessions/session-accessor.sqlite-participant-projection.js";
import { listSessionMembers } from "../config/sessions/session-sharing-store.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { listOpenIncognitoAgentDatabases } from "../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import { readSessionListSelectionFacts } from "./session-list-target.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import * as records from "./session-row-projection-record.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { deriveSessionTitle, type SessionChildLink } from "./session-utils-core.js";
import { materializeSessionRow, readSessionRowInputs } from "./session-utils-row.js";
import {
  createGatewaySessionEntryReader,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils-store-lookup.js";

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
      materializeArchived = false,
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
              databaseFacts ? { ...current, hasBoard: databaseFacts.hasBoard } : current,
              databaseFacts?.entry,
            );
          if (owner.revision() !== revision) {
            break;
          }
          if (row && databaseFacts) {
            row.preparedAcpMeta = databaseFacts.acpMeta;
          }
          if (row && isColdArchivedSessionRow(row) && !materializeArchived) {
            owner.dirty.delete(id);
            owner.forgetBackfill(id);
          } else if (row) {
            row.pendingDatabaseFacts = databaseFacts;
            row.retainedDatabaseFacts = databaseFacts;
          }
        }
      });
      refresh(ids, true);
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
  },
  activitySummaryEnabledByAgent?: Map<string, boolean>,
) {
  const { row, cfg, context } = params;
  const source = isIncognitoSessionKey(row.key)
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
    preparedAcpMeta: params.databaseFacts ? params.databaseFacts.acpMeta : row.preparedAcpMeta,
    configuredAgentIds: params.configuredAgentIds,
    store: source?.store ?? {},
    storePath: row.storeTarget.storePath,
    storeAgentId: row.storeTarget.agentId,
    // Cache stored fallback facts independently of the live activity chosen at presentation.
    active: source ? undefined : false,
    activeModel: source ? undefined : (row.fallbackModel ?? null),
    modelCatalog: params.modelCatalog,
    modelSource: {
      entry: row.storedEntry,
      readSourceEntry: source
        ? createGatewaySessionEntryReader({ cfg, ...source })
        : params.readSourceEntry,
    },
    rowContext: context,
    // Incognito rows are transient exact reads and never enter the resident backfill queue.
    includeDerivedTitles: Boolean(source),
    includeLastMessage: Boolean(source),
    skipTranscriptUsageFallback: true,
    includeSwarmChildren: true,
    storeChildSessionLinksByKey: source ? undefined : new Map([[row.key, params.links]]),
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
    databaseFacts: params.databaseFacts,
  });
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
      if (isIncognitoSessionKey(row.key)) {
        row.generation = readOpenClawAgentDatabaseIdentity(database).identity;
      }
      const cache = readCommittedSessionEntryCache(database.db);
      if (cache) {
        const entry = cache.get(row.key);
        return entry ? projectSqliteSessionParticipants(database.db, row.key, entry) : undefined;
      }
      return readExactSessionEntryRow(database, row.key, "list")?.entry;
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
  if (!storedEntry) {
    return undefined;
  }
  const entry = projectGatewaySessionEntry(cfg, storedEntry);
  return Object.assign(row, {
    storedEntry,
    entry,
    selection: readSessionListSelectionFacts(key, entry),
  });
}

/** Resident identities use indexes; private identities remain exact process-local reads. */
export function findSessionRowById(
  query: { sessionId: string; agentId?: string; storePath?: string },
  owner: {
    disposed: boolean;
    lookup: (query: records.Lookup) => records.Row | undefined;
    matching: (query: records.Query, kind?: string) => records.Row[];
  },
) {
  if (
    !query.agentId ||
    !query.storePath ||
    !isIncognitoOpenClawAgentSqlitePath(query.storePath, { agentId: query.agentId })
  ) {
    return owner.matching({ ...query, key: query.sessionId }, "id");
  }
  const key = !owner.disposed && resolveSessionKeyBySessionId(query);
  const row = key ? owner.lookup({ ...query, agentId: query.agentId, key }) : undefined;
  return row?.entry?.sessionId === query.sessionId ? [row] : [];
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

/** Install committed metadata inside the resident owner; missing facts keep its worker refresh pending. */
export function createSessionRowPublication(owner: {
  store: (path: string) => records.SessionRowStore | undefined;
  runAsOwner: <T>(run: () => T) => T;
  acquireEntry: (row: records.Row, entry: records.Row["storedEntry"]) => records.Row | undefined;
  markRelated: (row: records.Row, includeChildren: boolean) => void;
  invalidatePlacement: (sessionId: string) => void;
  enqueue: (row: records.Row) => void;
  defer: (row: records.Row) => void;
  remove: (id: string) => void;
}) {
  return function markStoredRow(
    row: records.Row,
    change: SessionRowChange,
    prepared = readPreparedSessionEntryChange(change, row.key),
  ) {
    const store = owner.store(row.storeTarget.storePath);
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
    const current =
      prepared &&
      source &&
      store?.identity === source.identity &&
      store.birthtime === source.birthtime &&
      store.filename === source.filename
        ? prepared
        : undefined;
    if (prepared && !current) {
      return;
    }
    const facts = "sessionKey" in change ? change.facts : undefined;
    if (facts?.kind === "removed") {
      owner.remove(records.identity(row));
      return;
    }
    if (current && !current.entry && !current.sharing) {
      return;
    }
    records.invalidateDatabaseFacts(row);
    if (row.entry) {
      owner.invalidatePlacement(row.entry.sessionId);
    }
    if (current?.entry) {
      const entry = current.entry;
      owner.markRelated(row, records.changesSessionRowDependents(row.storedEntry, entry));
      const acquired = owner.runAsOwner(() => {
        const next = { ...row, publishedSource: current.source };
        if (entry.archivedAt !== undefined && !getSubagentSessionListReadSnapshotIdentity()) {
          // Committed metadata survives while its independent lineage facts refill.
          next.sharingEntry = entry;
          owner.defer(next);
          return undefined;
        }
        return owner.acquireEntry(next, entry);
      });
      if (acquired) {
        owner.enqueue(acquired);
      }
      return;
    }
    if (current?.sharing) {
      const next =
        row.entry?.sessionId !== current.sharing.sessionId ||
        row.entry.lifecycleRevision !== current.sharing.lifecycleRevision
          ? (owner.runAsOwner(() =>
              owner.acquireEntry(records.renewGeneration(row), current.sharing),
            ) ?? row)
          : row;
      next.sharingEntry = current.sharing;
      owner.defer(next);
      return;
    }
    if (prepared) {
      // A bound identity notification may outlive metadata superseded by another publication.
      return;
    }
    // Unknown storage facts cannot retain sharing permission while their worker read is pending.
    if (
      !facts ||
      facts.kind === "entry" ||
      change.factsInvalidated ||
      ((facts.kind === "member" || facts.kind === "category") &&
        row.sharingEntry?.sessionId !== facts.sessionId)
    ) {
      row.sharingEntry = undefined;
    }
    owner.defer(row);
  };
}
