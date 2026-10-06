/**
 * Restart rehydration and downgrade protection.
 *
 * Rehydration completes before protected execution is enabled. A locked owner
 * that is unavailable after restart stays DELEGATED_LOCKED and available
 * execution stays denied; restart never releases a reservation.
 */
import type { DatabaseSync } from "node:sqlite";
import { listLiveOwnershipRows } from "./delegated-execution-ownership-store.js";
import { hasDelegatedExecutionOwnershipSchema } from "./delegated-execution-ownership.schema.js";
import {
  DELEGATED_EXECUTION_OWNERSHIP_ENFORCEMENT_VERSION,
  DELEGATED_EXECUTION_OWNERSHIP_STATES,
  type DelegatedExecutionOwnershipRecord,
  type DelegatedExecutionOwnershipState,
} from "./delegated-execution-ownership.types.js";

export const DELEGATED_EXECUTION_OWNERSHIP_SCHEMA_VERSION = 19;

export class DelegatedExecutionOwnershipRehydrationError extends Error {
  readonly reason: "read-failed" | "corrupt-row";
  constructor(reason: DelegatedExecutionOwnershipRehydrationError["reason"], message: string) {
    super(message);
    this.name = "DelegatedExecutionOwnershipRehydrationError";
    this.reason = reason;
  }
}

export class DelegatedExecutionOwnershipDowngradeError extends Error {
  readonly reason: "registry-missing" | "enforcement-floor";
  constructor(reason: DelegatedExecutionOwnershipDowngradeError["reason"], message: string) {
    super(message);
    this.name = "DelegatedExecutionOwnershipDowngradeError";
    this.reason = reason;
  }
}

export type DelegatedExecutionOwnershipRehydration = Readonly<{
  live: readonly DelegatedExecutionOwnershipRecord[];
  byRef: ReadonlyMap<string, DelegatedExecutionOwnershipRecord>;
  completedAt: number;
}>;

function isState(value: string): value is DelegatedExecutionOwnershipState {
  return (DELEGATED_EXECUTION_OWNERSHIP_STATES as readonly string[]).includes(value);
}

/** Reads every non-terminal reservation, refusing to continue on an unusable row. */
export function rehydrateDelegatedExecutionOwnership(params: {
  db: DatabaseSync;
  now?: number;
}): DelegatedExecutionOwnershipRehydration {
  let live: DelegatedExecutionOwnershipRecord[];
  try {
    live = listLiveOwnershipRows(params.db);
  } catch (error) {
    throw new DelegatedExecutionOwnershipRehydrationError(
      "read-failed",
      error instanceof Error ? error.message : "delegated execution ownership rehydration failed",
    );
  }
  const byRef = new Map<string, DelegatedExecutionOwnershipRecord>();
  for (const record of live) {
    if (!record.delegationRef || record.revision < 1 || !isState(record.state)) {
      throw new DelegatedExecutionOwnershipRehydrationError(
        "corrupt-row",
        "delegated execution ownership row is corrupt at " + record.delegationRef,
      );
    }
    byRef.set(record.delegationRef, record);
  }
  return Object.freeze({ live: Object.freeze(live), byRef, completedAt: params.now ?? Date.now() });
}

/** Restart keeps an unavailable delegate owner locked; it never releases. */
export function isLockedAfterRestart(record: DelegatedExecutionOwnershipRecord): boolean {
  return record.state === "DELEGATED_LOCKED" || record.state === "FALLBACK_AUTHORIZED";
}

/**
 * The smallest downgrade protection the shared-state architecture supports:
 * a database that published schema v19 but lost the registry is a rolled-back
 * artifact and is refused, and a reservation written by a build with a higher
 * enforcement floor is refused outright.
 */
export function assertDelegatedExecutionOwnershipDowngradeSafe(params: {
  db: DatabaseSync;
  supportedEnforcementVersion?: number;
  publishedSchemaVersion?: number;
}): void {
  const supported =
    params.supportedEnforcementVersion ?? DELEGATED_EXECUTION_OWNERSHIP_ENFORCEMENT_VERSION;
  if (!hasDelegatedExecutionOwnershipSchema(params.db)) {
    if ((params.publishedSchemaVersion ?? 0) >= DELEGATED_EXECUTION_OWNERSHIP_SCHEMA_VERSION) {
      throw new DelegatedExecutionOwnershipDowngradeError(
        "registry-missing",
        "state database published schema v19 without the delegated execution ownership registry",
      );
    }
    return;
  }
  let live: DelegatedExecutionOwnershipRecord[];
  try {
    live = listLiveOwnershipRows(params.db);
  } catch (error) {
    throw new DelegatedExecutionOwnershipRehydrationError(
      "read-failed",
      error instanceof Error ? error.message : "delegated execution ownership read failed",
    );
  }
  for (const record of live) {
    if (record.enforcementFloor > supported) {
      throw new DelegatedExecutionOwnershipDowngradeError(
        "enforcement-floor",
        "delegation " +
          record.delegationRef +
          " requires enforcement version " +
          record.enforcementFloor,
      );
    }
  }
}

/** Startup gate: rehydrate fully, then verify downgrade safety, before enabling execution. */
export function prepareDelegatedExecutionOwnershipStartup(params: {
  db: DatabaseSync;
  supportedEnforcementVersion?: number;
  publishedSchemaVersion?: number;
  now?: number;
}): DelegatedExecutionOwnershipRehydration {
  const rehydration = rehydrateDelegatedExecutionOwnership(
    params.now === undefined ? { db: params.db } : { db: params.db, now: params.now },
  );
  assertDelegatedExecutionOwnershipDowngradeSafe({
    db: params.db,
    ...(params.supportedEnforcementVersion === undefined
      ? {}
      : { supportedEnforcementVersion: params.supportedEnforcementVersion }),
    ...(params.publishedSchemaVersion === undefined
      ? {}
      : { publishedSchemaVersion: params.publishedSchemaVersion }),
  });
  return rehydration;
}
