import { isDeepStrictEqual } from "node:util";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import { projectGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { resolveProjectedAgentRunModel } from "../infra/agent-run-registry.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import {
  readSessionRowHasBoard,
  type readSessionRowFacts,
} from "./server-methods/session-placement-read-projection.js";
import { compareSessionEntryPairs } from "./session-list-order.js";
import { readSessionListSelectionFacts } from "./session-list-target.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import * as rowProjection from "./session-utils-row.js";

export type Row = {
  key: string;
  agentId: string;
  storeTarget: SessionStoreTarget;
  storedEntry?: SessionEntry;
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
> & { active?: boolean };
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
) {
  for (const id of dependents(row, indexes.byParent)) {
    dirty.add(id);
  }
  for (const parent of row.parents) {
    for (const id of indexes.byKey.get(parent) ?? []) {
      dirty.add(id);
    }
  }
}

/** Mark resident logical owners without changing stored entries, relatives, or backfill. */
export function markAutomation(
  rows: Iterable<Row>,
  agentId: string | undefined,
  dirty: Set<string>,
) {
  for (const row of rows) {
    if (!agentId || row.agentId === agentId) {
      dirty.add(identity(row));
    }
  }
}

export function create(target: RowTarget, entry?: SessionEntry): Row {
  return {
    ...target,
    storedEntry: entry,
    selection: readSessionListSelectionFacts(target.key, entry),
    parents: new Set(),
    membership: new Set(),
    generation: Symbol("row"),
  };
}
export type EntryRow = Row & Required<Pick<Row, "entry">>;
export type MaterializedRow = EntryRow & Required<Pick<Row, "materialized">>;
export function hasEntry(row: Row | undefined): row is EntryRow {
  return Boolean(row?.entry);
}
export function ready(row: Row | undefined): row is MaterializedRow {
  return Boolean(row?.entry && row.materialized);
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
    subagentRuns: context.subagentRuns.atTime(now),
    activeModel: active ? (live ?? undefined) : record.fallbackModel,
    excludedChildKeys: options.excludedChildKeys,
  });
  Object.assign(row, record.facts?.present());
  if (!options.includeDerivedTitles) {
    delete row.derivedTitle;
  }
  if (!options.includeLastMessage) {
    delete row.lastMessagePreview;
  }
  return row;
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
) {
  if (sourcePath && (key === "global" || key === "unknown")) {
    return physical(sourcePath, key);
  }
  const agentId = parseAgentSessionKey(key)?.agentId ?? fallbackAgentId;
  return logical(agentId, resolveStoredSessionKeyForAgentStore({ cfg, agentId, sessionKey: key }));
}

/** Drop reader-only graphs while retaining cold metadata and index identity. */
export function dematerialize(row: Row): Row {
  return {
    ...row,
    materialized: undefined,
    materializedSequence: undefined,
    facts: undefined,
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
) {
  const parents = new Set<string>();
  const addParent = (key: string | null | undefined) => {
    if (key && key !== row.key) {
      parents.add(parentReference(cfg, key, row.agentId, row.storeTarget.storePath));
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
  remove: (id: string) => void;
  put: (row: Row) => void;
  markRelated: (row: Row) => void;
  archive: { demote: (row: Row) => Row; forget: (id: string) => void };
}) {
  const { row, storedEntry, cfg, context, remove, put, archive } = params;
  if (!storedEntry || storedEntry.incognito) {
    remove(identity(row));
    return undefined;
  }
  const entry = projectGatewaySessionEntry(cfg, storedEntry);
  const parents = readSessionRowParents(row, storedEntry, cfg, context);
  // Equal timestamps still need the full metadata comparison.
  const changed =
    !sameParents(row.parents, parents) ||
    !Object.is(storedEntry.updatedAt, row.storedEntry?.updatedAt) ||
    !isDeepStrictEqual(storedEntry, row.storedEntry);
  if (changed) {
    params.markRelated(row);
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
    entry,
    // Selection metadata survives archive dematerialization and refreshes with the entry.
    selection: readSessionListSelectionFacts(row.key, entry),
    parents,
    generation,
    hasBoard:
      entry.archivedAt !== undefined ? (row.hasBoard ?? readSessionRowHasBoard(row)) : row.hasBoard,
    fallbackModel: sameFallbackModelFacts(row.storedEntry, storedEntry)
      ? row.fallbackModel
      : undefined,
    ...(generation !== row.generation
      ? { lastMessagePreview: undefined, fallbackModel: undefined, materialized: undefined }
      : {}),
  };
  put(next);
  if (entry.archivedAt !== undefined && row.entry?.archivedAt === undefined) {
    next = archive.demote(next);
  } else if (entry.archivedAt === undefined) {
    archive.forget(identity(next));
  }
  if (changed) {
    params.markRelated(next);
  }
  return next;
}
