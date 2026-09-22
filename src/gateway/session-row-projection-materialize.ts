import { performance } from "node:perf_hooks";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { projectGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import { readCommittedSessionEntryCache } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { resolveSessionKeyBySessionId } from "../config/sessions/session-accessor.sqlite-entry.js";
import { listSessionMembers } from "../config/sessions/session-sharing-store.js";
import type { SessionRowDatabaseFacts } from "../config/sessions/session-transcript-worker.types.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
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
export function refreshSessionRowMaterializations(owner: {
  ids: readonly string[];
  prepared?: ReadonlyMap<string, SessionRowDatabaseFacts>;
  rows: ReadonlyMap<string, records.Row>;
  dirty: Set<string>;
  prepare: () => records.Inputs["cfg"];
  revision: () => number;
  acquireEntry: (row: records.Row, entry: records.Row["storedEntry"]) => records.Row | undefined;
  materialize: (
    row: records.Row,
    agentIds: Set<string>,
    read: typeof readResidentSessionRow,
    facts?: SessionRowDatabaseFacts,
  ) => boolean;
  forgetBackfill: (id: string) => void;
}) {
  const started = performance.now();
  const cfg = owner.prepare();
  const configuredAgentIds = new Set(listAgentIds(cfg));
  const readRow = createSessionRowMaterializationBatch();
  for (const [offset, id] of owner.ids.entries()) {
    if (offset > 0 && performance.now() - started >= 12) {
      break;
    }
    const current = owner.rows.get(id),
      revision = owner.revision();
    const databaseFacts = owner.prepared?.get(id);
    const row =
      current &&
      owner.acquireEntry(
        databaseFacts ? { ...current, hasBoard: databaseFacts.hasBoard } : current,
        owner.prepared ? databaseFacts?.entry : readSessionRowEntry(current),
      );
    if (row && isColdArchivedSessionRow(row)) {
      owner.dirty.delete(id);
      owner.forgetBackfill(id);
      continue;
    }
    if (
      row &&
      owner.materialize(row, configuredAgentIds, readRow, databaseFacts) &&
      owner.revision() === revision
    ) {
      owner.dirty.delete(id);
    }
    if (owner.revision() !== revision) {
      break;
    }
  }
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
    databaseFacts?: SessionRowDatabaseFacts;
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
    fallbackModel: presentation.activeModel,
    facts,
    hasBoard: facts.hasBoard,
    membership: new Set(
      params.databaseFacts?.memberIdentityIds ??
        listSessionMembers({ ...row.storeTarget, sessionKey: row.key }).map(
          (member) => member.identityId,
        ),
    ),
  };
}

export function readSessionRowEntry(row: records.Row) {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      if (isIncognitoSessionKey(row.key)) {
        row.generation = readOpenClawAgentDatabaseIdentity(database).identity;
      }
      const cache = readCommittedSessionEntryCache(database.db);
      return cache
        ? cache.get(row.key)
        : readExactSessionEntryRow(database, row.key, "list")?.entry;
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
