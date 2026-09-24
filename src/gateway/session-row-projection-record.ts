import { isDeepStrictEqual } from "node:util";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import { projectGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import type { GatewayStoredSessionTargets } from "../config/sessions/combined-store-model-sources.js";
import type { SessionRowDatabaseFacts } from "../config/sessions/session-transcript-worker.types.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type {
  InternalSessionEntry as SessionEntry,
  SessionAcpMeta,
} from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProjectedAgentRunModel } from "../infra/agent-run-registry.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import type { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import { compareSessionEntryPairs } from "./session-list-order.js";
import { readSessionListSelectionFacts } from "./session-list-target.js";
import { selectStoredSessionLineage } from "./session-store-key.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import * as rowProjection from "./session-utils-row.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

export type ProjectionOptions = {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  getPolicyConfig?: () => OpenClawConfig;
  modelCatalog?: Inputs["modelCatalog"];
  getModelCatalog?: () => Promise<Inputs["modelCatalog"]>;
  context?: Parameters<typeof readSessionRowFacts>[0]["context"];
  placementFactsReader?: Pick<WorkerSessionPlacementStore, "readProjection">;
};

export type PreparedSessionRowDatabaseFacts = SessionRowDatabaseFacts & {
  acpMeta: SessionAcpMeta | null;
};

export type SessionRowStore = {
  target: SessionStoreTarget;
  agentId: string;
  discoveryAgentId: string | null;
  discoveryOrder?: number;
  identity: string | symbol;
  birthtime: string | undefined;
  filename: string;
};

export type Row = {
  key: string;
  agentId: string;
  storeTarget: SessionStoreTarget;
  storedEntry?: SessionEntry;
  /** Accepted under retained database custody; presentation consumes the whole snapshot. */
  pendingDatabaseFacts?: PreparedSessionRowDatabaseFacts;
  /** Durable search metadata survives archive demotion, until its owner invalidates it. */
  preparedAcpMeta?: SessionAcpMeta | null;
  databaseFactsRevision: number;
  /** Current committed sharing facts remain usable while display materialization is dirty. */
  sharingEntry?: SessionEntry;
  entry?: SessionEntry;
  selection: ReturnType<typeof readSessionListSelectionFacts>;
  materialized?: ReturnType<typeof rowProjection.materializeSessionRow>;
  materializedSequence?: number;
  profileRevision?: number;
  subagentRevision?: number;
  lastMessagePreview?: string;
  fallbackModel?: ReturnType<
    typeof rowProjection.readSessionRowInputs
  >["presentation"]["activeModel"];
  facts?: ReturnType<typeof readSessionRowFacts>;
  hasBoard?: boolean;
  membership: ReadonlySet<string>;
  parents: Set<string>;
  generation: string | symbol;
};
export type Query = {
  agentId?: string;
  storePath?: string;
  key?: string;
  sessionIdOrKey?: string;
  parentSessionKey?: string;
  sortBy?: Parameters<typeof compareSessionEntryPairs>[2] | null;
};
export type Inputs = Parameters<typeof rowProjection.readSessionRowInputs>[0];
export type SnapshotOptions = Pick<
  Inputs,
  "now" | "includeDerivedTitles" | "includeLastMessage" | "excludedChildKeys"
> & { active?: boolean; subagentRuns?: SessionListRowContext["subagentRuns"] };
export type Lookup = { agentId: string; key: string; storePath?: string };
type RowTarget = Pick<Row, "agentId" | "key" | "storeTarget">;
export const identity = (row: RowTarget) =>
  `${row.agentId}\0${row.storeTarget.storePath}\0${row.key}`;
export const physical = (storePath: string, key: string) => `physical:${storePath}\0${key}`;
const logical = (agentId: string, key: string) => `logical:${agentId}\0${key}`;
export function dependents(row: Row, byParent: ReadonlyMap<string, Set<string>>) {
  const children = new Set(byParent.get(logical(row.agentId, row.key)));
  const physicalChildren = byParent.get(physical(row.storeTarget.storePath, row.key));
  if (physicalChildren) {
    for (const id of physicalChildren) {
      children.add(id);
    }
  }
  return children;
}
export function markRelated(
  row: Row,
  indexes: {
    byParent: ReadonlyMap<string, Set<string>>;
    byKey: ReadonlyMap<string, Set<string>>;
  },
  dirty: Set<string>,
  includeChildren = true,
  cfg?: Inputs["cfg"],
) {
  if (includeChildren) {
    for (const id of dependents(row, indexes.byParent)) {
      dirty.add(id);
    }
    if (cfg && parseAgentSessionKey(row.key)) {
      // A new literal parent must wake children still indexed under its absent-row alias.
      for (const id of indexes.byParent.get(parentReference(cfg, row.key, row.agentId)) ?? []) {
        dirty.add(id);
      }
    }
  }
  for (const parent of row.parents) {
    for (const id of indexes.byKey.get(parent) ?? []) {
      dirty.add(id);
    }
  }
}

/** Children consume parent model overrides, not its changing progress or display metadata. */
export function changesSessionRowDependents(before: Row["storedEntry"], after: Row["storedEntry"]) {
  return (
    !before ||
    !after ||
    before.sessionId !== after.sessionId ||
    before.lifecycleRevision !== after.lifecycleRevision ||
    before.providerOverride !== after.providerOverride ||
    before.modelOverride !== after.modelOverride ||
    before.modelOverrideSource !== after.modelOverrideSource ||
    before.modelOverrideRouteResolution !== after.modelOverrideRouteResolution ||
    before.modelOverrideFallbackOriginProvider !== after.modelOverrideFallbackOriginProvider ||
    before.modelOverrideFallbackOriginModel !== after.modelOverrideFallbackOriginModel
  );
}

/** Mark resident logical owners without changing stored entries, relatives, or backfill. */
export function markAutomation(
  rows: Iterable<Row>,
  agentId: string | undefined,
  dirty: Set<string>,
) {
  for (const row of rows) {
    if (!agentId || row.agentId === agentId) {
      invalidateDatabaseFacts(row);
      dirty.add(identity(row));
    }
  }
}

/** Expire both accepted facts and worker replies still waiting to enter this row. */
export function invalidateDatabaseFacts(row: Row) {
  row.databaseFactsRevision++;
  row.pendingDatabaseFacts = undefined;
  row.preparedAcpMeta = undefined;
}

export function create(target: RowTarget, entry?: SessionEntry): Row {
  return {
    ...target,
    storedEntry: entry,
    sharingEntry: entry,
    selection: readSessionListSelectionFacts(target.key, entry),
    parents: new Set(),
    membership: new Set(),
    generation: Symbol("row"),
    databaseFactsRevision: 0,
  };
}

/** Seed the complete identity inventory before any row selects its stored lineage. */
export function seedSessionRowEntries(params: {
  targets: GatewayStoredSessionTargets;
  rows: ReadonlyMap<string, Row>;
  replaced: ReadonlySet<string>;
  remove: (id: string) => void;
  put: (row: Row) => void;
}) {
  const { targets, rows, replaced, remove, put } = params;
  const admitted = new Set<string>();
  const acquisitions: Array<{ row: Row; entry: SessionEntry }> = [];
  for (const [key, target] of targets) {
    const entry = target.entry;
    if (!entry || entry.incognito || isIncognitoSessionKey(key)) {
      continue;
    }
    const fields = {
      key: target.storeKey ?? key,
      agentId: target.agentId,
      storeTarget: target.storeTarget,
    };
    const id = identity(fields);
    admitted.add(id);
    if (!rows.has(id) || replaced.has(target.storeTarget.storePath)) {
      remove(id);
      const row = create(fields, entry);
      put(row);
      acquisitions.push({ row, entry });
    } else {
      const row = rows.get(id)!;
      if (row.entry?.archivedAt !== undefined) {
        acquisitions.push({ row, entry });
      }
    }
  }
  for (const id of rows.keys()) {
    if (!admitted.has(id)) {
      remove(id);
    }
  }
  return acquisitions;
}

export function renewGeneration(row: Row): Row {
  return {
    ...row,
    entry: undefined,
    storedEntry: undefined,
    pendingDatabaseFacts: undefined,
    preparedAcpMeta: undefined,
    sharingEntry: undefined,
    materialized: undefined,
    lastMessagePreview: undefined,
    fallbackModel: undefined,
    generation: Symbol("row"),
  };
}

export type EntryRow = Row & Required<Pick<Row, "entry">>;
export type MaterializedRow = EntryRow & Required<Pick<Row, "materialized">>;
export function hasEntry(row: Row | undefined): row is EntryRow {
  return Boolean(row?.entry);
}
export function ready(row: Row | undefined): row is MaterializedRow {
  // Acquisition can advance metadata before rendering, including after pending facts expire.
  return Boolean(row?.entry && row.materialized?.source.entry === row.entry);
}

export function publishTranscriptFields(
  row: MaterializedRow,
  fields: Pick<Row, "lastMessagePreview" | "fallbackModel">,
  cfg: Inputs["cfg"],
  context: SessionListRowContext,
): boolean {
  // Same-generation metadata may change while transcript work is awaiting publication.
  const fallbackModel = rowProjection.resolveGatewaySessionActiveModel({
    cfg,
    agentId: row.agentId,
    sessionId: row.entry.sessionId,
    sessionKey: row.key,
    storePath: row.storeTarget.storePath,
    entry: row.entry,
    selectedModel: row.materialized.source.selectedModel,
    projectedAgentRuns: context.projectedAgentRuns!,
    active: false,
    activeModel: fields.fallbackModel ?? null,
  });
  if (
    row.lastMessagePreview === fields.lastMessagePreview &&
    isDeepStrictEqual(row.fallbackModel, fallbackModel)
  ) {
    return false;
  }
  Object.assign(row, { lastMessagePreview: fields.lastMessagePreview, fallbackModel });
  row.materialized.source.lastMessagePreview = fields.lastMessagePreview;
  row.materialized.row.lastMessagePreview = fields.lastMessagePreview;
  return true;
}

export function sort<T extends EntryRow>(rows: T[], sortBy: Query["sortBy"]): T[] {
  return sortBy === null
    ? rows
    : rows.toSorted((a, b) => compareSessionEntryPairs([a.key, a.entry], [b.key, b.entry], sortBy));
}

function sameFallbackModelFacts(previous: Row["storedEntry"], current: SessionEntry) {
  return (
    previous?.modelProvider === current.modelProvider &&
    previous?.model === current.model &&
    previous?.lastRunId === current.lastRunId &&
    isDeepStrictEqual(previous?.fallbackNotice, current.fallbackNotice)
  );
}

export function first(candidates: Row[], storePaths: Iterable<string>) {
  if (candidates.length < 2) {
    return candidates[0];
  }
  for (const sourcePath of storePaths) {
    for (const row of candidates) {
      if (row.storeTarget.storePath === sourcePath) {
        return row;
      }
    }
  }
  return undefined;
}

export function firstReferenced(
  ref: string,
  rows: ReadonlyMap<string, Row>,
  byKey: ReadonlyMap<string, ReadonlySet<string>>,
  storePaths: Iterable<string>,
) {
  return first(
    [...(byKey.get(ref) ?? [])].flatMap((id) => rows.get(id) ?? []),
    storePaths,
  );
}

export function present(
  record: MaterializedRow,
  context: SessionListRowContext,
  options: SnapshotOptions = {},
) {
  const now = options.now ?? Date.now();
  const live = resolveProjectedAgentRunModel({
    agentId: record.agentId,
    sessionId: record.entry.sessionId,
    index: context.projectedAgentRuns!,
  });
  const active = options.active ?? (live !== undefined || record.entry.status === "running");
  const row = rowProjection.presentSessionRow(record.materialized, {
    now,
    subagentRuns: options.subagentRuns ?? context.subagentRuns.atTime(now),
    projectedAgentRuns: context.projectedAgentRuns,
    projectedSubagentActivity: context.projectedSubagentActivity,
    activeModel: active ? (live ?? undefined) : record.fallbackModel,
    excludedChildKeys: options.excludedChildKeys,
  });
  Object.assign(row, record.facts?.present());
  // Undefined omits wire fields without converting each presented row to dictionary storage.
  if (!options.includeDerivedTitles) {
    row.derivedTitle = undefined;
  }
  if (!options.includeLastMessage) {
    row.lastMessagePreview = undefined;
  }
  return row;
}

/** The wire snapshot and lifecycle identity come from the same materialized record. */
export function snapshot(
  row: MaterializedRow | undefined,
  context: SessionListRowContext,
  options: SnapshotOptions,
) {
  return row
    ? { row: present(row, context, options), lifecycleRunId: row.entry.lifecycleRunId }
    : { row: null };
}

function updateIndex(
  map: Map<string, Set<string>>,
  key: string | undefined,
  id: string,
  deleting: boolean,
) {
  if (!key) {
    return;
  }
  const values = map.get(key);
  if (deleting) {
    values?.delete(id);
    if (values?.size === 0) {
      map.delete(key);
    }
  } else if (values) {
    values.add(id);
  } else {
    map.set(key, new Set([id]));
  }
}

export function index(
  row: Row,
  indexes: {
    byStore: Map<string, Set<string>>;
    byAgent: Map<string, Set<string>>;
    byKey: Map<string, Set<string>>;
    byParent: Map<string, Set<string>>;
  },
  deleting = false,
) {
  const { byStore, byAgent, byKey, byParent } = indexes;
  const id = identity(row);
  updateIndex(byStore, row.storeTarget.storePath, id, deleting);
  updateIndex(byAgent, row.agentId, id, deleting);
  updateIndex(byKey, `key:${row.key}`, id, deleting);
  updateIndex(byKey, row.entry && `id:${row.entry.sessionId}`, id, deleting);
  updateIndex(byKey, logical(row.agentId, row.key), id, deleting);
  updateIndex(byKey, physical(row.storeTarget.storePath, row.key), id, deleting);
  for (const parent of row.parents) {
    updateIndex(byParent, parent, id, deleting);
  }
}

export function changesRowStructure(row: Row, entry: Row["storedEntry"]): boolean {
  const previous = row.storedEntry;
  return (
    !previous ||
    !entry ||
    previous.sessionId !== entry.sessionId ||
    previous.lifecycleRevision !== entry.lifecycleRevision ||
    previous.parentSessionKey !== entry.parentSessionKey ||
    previous.spawnedBy !== entry.spawnedBy ||
    previous.incognito !== entry.incognito ||
    previous.archivedAt !== entry.archivedAt
  );
}

export function isCurrentGeneration(row: Row, current: Row | undefined): boolean {
  return (
    current?.generation === row.generation &&
    (!isIncognitoSessionKey(row.key) ||
      (current.entry?.sessionId === row.entry?.sessionId &&
        current.entry?.lifecycleRevision === row.entry?.lifecycleRevision))
  );
}

export function parentReference(
  cfg: Inputs["cfg"],
  key: string,
  fallbackAgentId: string,
  sourcePath?: string,
  referenced?: (reference: string) => Row | undefined,
) {
  return selectSessionRowParent(cfg, key, fallbackAgentId, sourcePath, referenced).reference;
}

function selectSessionRowParent(
  cfg: Inputs["cfg"],
  key: string,
  fallbackAgentId: string,
  sourcePath?: string,
  referenced?: (reference: string) => Row | undefined,
) {
  if (sourcePath && (key === "global" || key === "unknown")) {
    return { key, reference: physical(sourcePath, key) };
  }
  const selected = selectStoredSessionLineage({
    cfg,
    agentId: fallbackAgentId,
    sessionKey: key,
    read: (agentId, sessionKey) => referenced?.(logical(agentId, sessionKey))?.storedEntry,
  });
  return { key: selected.key, reference: logical(selected.agentId, selected.key) };
}

/** Drop reader-only graphs while retaining cold metadata and index identity. */
export function dematerialize(row: Row): Row {
  return {
    ...row,
    materialized: undefined,
    materializedSequence: undefined,
    facts: undefined,
    pendingDatabaseFacts: undefined,
    databaseFactsRevision: row.databaseFactsRevision + 1,
    membership: new Set<string>(),
    lastMessagePreview: undefined,
    fallbackModel: undefined,
  };
}

export function readSessionRowParents(
  row: Row,
  storedEntry: SessionEntry,
  cfg: Inputs["cfg"],
  context: SessionListRowContext,
  referenced?: (reference: string) => Row | undefined,
) {
  const parents = new Set<string>();
  const addParent = (key: string | null | undefined) => {
    if (key && key !== row.key) {
      parents.add(parentReference(cfg, key, row.agentId, row.storeTarget.storePath, referenced));
    }
  };
  addParent(storedEntry.parentSessionKey ?? resolveSessionParentSessionKey(row.key));
  addParent(storedEntry.spawnedBy);
  const runs = context.subagentRunsByChildSessionKey.get(row.key);
  if (runs) {
    for (const run of runs) {
      addParent(run.controllerSessionKey || run.requesterSessionKey);
    }
  }
  return parents;
}

/** Reproject held lineage without acquiring board, transcript, or database facts. */
export function readSessionRowLineage(
  row: Row,
  storedEntry: SessionEntry,
  cfg: Inputs["cfg"],
  context: SessionListRowContext,
  referenced?: (reference: string) => Row | undefined,
) {
  const entry = projectGatewaySessionEntry(
    cfg,
    storedEntry,
    (key) =>
      selectSessionRowParent(cfg, key, row.agentId, row.storeTarget.storePath, referenced).key,
  );
  return {
    entry,
    parents: readSessionRowParents(row, storedEntry, cfg, context, referenced),
    selection: readSessionListSelectionFacts(row.key, entry),
  };
}

export function sameParents(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const parent of left) {
    if (!right.has(parent)) {
      return false;
    }
  }
  return true;
}

export function acquireSessionRowEntry(params: {
  row: Row;
  storedEntry: SessionEntry | undefined;
  cfg: Inputs["cfg"];
  context: SessionListRowContext;
  referenced?: (reference: string) => Row | undefined;
  remove: (id: string) => void;
  put: (row: Row) => void;
  markRelated: (row: Row, includeChildren: boolean) => void;
  archive: { demote: (row: Row) => Row; forget: (id: string) => void };
}) {
  const { row, storedEntry, cfg, context, remove, put, archive } = params;
  if (!storedEntry || storedEntry.incognito) {
    remove(identity(row));
    return undefined;
  }
  const lineage = readSessionRowLineage(row, storedEntry, cfg, context, params.referenced);
  const { entry, parents } = lineage;
  // Equal timestamps still need the full metadata comparison.
  const changed =
    !sameParents(row.parents, parents) ||
    !Object.is(storedEntry.updatedAt, row.storedEntry?.updatedAt) ||
    !isDeepStrictEqual(storedEntry, row.storedEntry);
  const includeChildren = changesSessionRowDependents(row.storedEntry, storedEntry);
  if (changed) {
    params.markRelated(row, includeChildren);
  }
  const generation =
    !row.entry ||
    (row.entry.sessionId === entry.sessionId &&
      row.entry.lifecycleRevision === entry.lifecycleRevision)
      ? row.generation
      : Symbol("row");
  let next: Row = {
    ...row,
    storedEntry,
    pendingDatabaseFacts: undefined,
    databaseFactsRevision: row.databaseFactsRevision + 1,
    ...lineage,
    sharingEntry: entry,
    generation,
    fallbackModel: sameFallbackModelFacts(row.storedEntry, storedEntry)
      ? row.fallbackModel
      : undefined,
    ...(generation !== row.generation
      ? {
          lastMessagePreview: undefined,
          fallbackModel: undefined,
          materialized: undefined,
          preparedAcpMeta: undefined,
        }
      : {}),
  };
  put(next);
  if (entry.archivedAt !== undefined && row.entry?.archivedAt === undefined) {
    next = archive.demote(next);
  } else if (entry.archivedAt === undefined) {
    archive.forget(identity(next));
  }
  if (changed) {
    params.markRelated(next, includeChildren);
  }
  return next;
}
