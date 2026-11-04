// Hot-path projection of live continuation custody (RFC §5.4.6). Synchronous
// guards ask "does this owner have live continuation work" without awaiting a
// worker. The projection derives only from committed worker results: startup
// hydration installs the full live set, and every custody write installs the
// post-commit live set of each owner it touched. A write whose outcome is
// unknown invalidates its owners until the next committed fact for them.
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import type {
  ContinuationEndedRecordFact,
  ContinuationLiveRecordFact,
  ContinuationOwnerLiveSet,
  ContinuationRecord,
  ContinuationRecordKind,
} from "./custody-store.types.js";

/** Terminal transitions kept for queue-rate metrics; older ones age out. */
const ENDED_FACT_LIMIT = 1_024;

export type ContinuationLiveWorkAnswer =
  | { state: "known"; records: readonly ContinuationLiveRecordFact[] }
  | { state: "unknown" };

type DatabaseProjection = {
  hydrated: boolean;
  owners: Map<string, readonly ContinuationLiveRecordFact[]>;
  invalidOwners: Set<string>;
  ended: ContinuationEndedRecordFact[];
};

const projections = resolveGlobalSingleton(
  Symbol.for("openclaw.continuationCustodyProjection"),
  () => new Map<string, DatabaseProjection>(),
);

function projectionFor(databasePath: string): DatabaseProjection {
  let projection = projections.get(databasePath);
  if (!projection) {
    projection = { hydrated: false, owners: new Map(), invalidOwners: new Set(), ended: [] };
    projections.set(databasePath, projection);
  }
  return projection;
}

function installOwner(projection: DatabaseProjection, live: ContinuationOwnerLiveSet): void {
  projection.invalidOwners.delete(live.ownerSessionKey);
  if (live.records.length === 0) {
    projection.owners.delete(live.ownerSessionKey);
  } else {
    projection.owners.set(live.ownerSessionKey, live.records);
  }
}

/** Replace the whole projection from a committed list of live records. */
export function hydrateContinuationCustodyProjection(
  databasePath: string,
  liveRecords: readonly ContinuationRecord[],
): void {
  const grouped = new Map<string, ContinuationLiveRecordFact[]>();
  for (const record of liveRecords) {
    if (record.status !== "queued" && record.status !== "running") {
      continue;
    }
    const facts = grouped.get(record.ownerSessionKey) ?? [];
    facts.push({
      recordId: record.recordId,
      kind: record.kind,
      status: record.status,
      revision: record.revision,
      cancelRequested: record.cancelRequestedAt !== undefined,
      createdAt: record.createdAt,
      ...(record.dueAt !== undefined ? { dueAt: record.dueAt } : {}),
    });
    grouped.set(record.ownerSessionKey, facts);
  }
  projections.set(databasePath, {
    hydrated: true,
    owners: grouped,
    invalidOwners: new Set(),
    // Terminal transitions committed before hydration stay counted.
    ended: projections.get(databasePath)?.ended ?? [],
  });
}

/** Whether startup hydration has installed this database's live set. */
export function isContinuationCustodyProjectionHydrated(databasePath: string): boolean {
  return projections.get(databasePath)?.hydrated === true;
}

/** Install the post-commit live sets a custody write reported. */
export function installContinuationCustodyCommit(
  databasePath: string,
  owners: readonly ContinuationOwnerLiveSet[],
  ended: readonly ContinuationEndedRecordFact[] = [],
): void {
  const projection = projectionFor(databasePath);
  for (const live of owners) {
    installOwner(projection, live);
  }
  if (ended.length > 0) {
    projection.ended.push(...ended);
    if (projection.ended.length > ENDED_FACT_LIMIT) {
      projection.ended.splice(0, projection.ended.length - ENDED_FACT_LIMIT);
    }
  }
}

/** A write whose commit is unknown leaves these owners unknown until their next committed fact. */
export function invalidateContinuationCustodyOwners(
  databasePath: string,
  ownerSessionKeys: readonly string[],
): void {
  const projection = projectionFor(databasePath);
  for (const owner of ownerSessionKeys) {
    projection.owners.delete(owner);
    projection.invalidOwners.add(owner);
  }
}

/** Synchronous live-work read; `unknown` before hydration or after an unresolved write. */
export function readContinuationLiveWork(
  databasePath: string,
  ownerSessionKey: string,
  kinds?: readonly ContinuationRecordKind[],
): ContinuationLiveWorkAnswer {
  const projection = projections.get(databasePath);
  if (!projection?.hydrated || projection.invalidOwners.has(ownerSessionKey)) {
    return { state: "unknown" };
  }
  const records = projection.owners.get(ownerSessionKey) ?? [];
  return {
    state: "known",
    records: kinds ? records.filter((record) => kinds.includes(record.kind)) : records,
  };
}

/**
 * Every owner's live facts plus recent terminal transitions, for queue
 * metrics. `unknown` before hydration; owners with an unresolved write are
 * left out of `owners` rather than reported stale, and named in `unknownOwners`.
 */
export function readContinuationCustodySnapshot(databasePath: string):
  | {
      state: "known";
      owners: ReadonlyMap<string, readonly ContinuationLiveRecordFact[]>;
      unknownOwners: ReadonlySet<string>;
      ended: readonly ContinuationEndedRecordFact[];
    }
  | { state: "unknown" } {
  const projection = projections.get(databasePath);
  if (!projection?.hydrated) {
    return { state: "unknown" };
  }
  return {
    state: "known",
    owners: projection.owners,
    unknownOwners: projection.invalidOwners,
    ended: projection.ended,
  };
}

/** Drop the projection with its database lifecycle (close, reset, or test teardown). */
export function resetContinuationCustodyProjection(databasePath?: string): void {
  if (databasePath === undefined) {
    projections.clear();
  } else {
    projections.delete(databasePath);
  }
}
