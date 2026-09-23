import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  parseStateLeaseProcessOwner,
  readStateLeaseProcessOwnerStatus,
  type StateLeaseProcessOwner,
} from "../infra/state-lease-process-owner.js";
import type { DB } from "./openclaw-state-db.generated.js";

export type OpenClawStateLeaseIdentity = { scope: string; key: string; owner: string };
export type OpenClawStateLeaseAcquisition =
  | { kind: "acquired"; expiresAt: number }
  | { kind: "held"; holder: { owner: string; epoch: number } };
type LeaseDatabase = Pick<DB, "state_leases">;

/** The caller owns the write transaction; only absent or expired leases can be acquired. */
export function acquireOpenClawStateLeaseInTransaction(
  db: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
  leaseMs: number,
  payloadJson: string | null = null,
): OpenClawStateLeaseAcquisition {
  // BEGIN IMMEDIATE may wait on SQLite. Sample only after admission so a
  // successful insert never commits an already-expired lease.
  const now = Date.now();
  const kysely = getNodeSqliteKysely<LeaseDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("state_leases")
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key)
      .where("expires_at", "<=", now),
  );
  const expiresAt = now + leaseMs;
  const inserted = executeSqliteQuerySync(
    db,
    kysely
      .insertInto("state_leases")
      .values({
        scope: identity.scope,
        lease_key: identity.key,
        owner: identity.owner,
        expires_at: expiresAt,
        heartbeat_at: now,
        payload_json: payloadJson,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.columns(["scope", "lease_key"]).doNothing()),
  );
  if (inserted.numAffectedRows === 1n) {
    return { kind: "acquired", expiresAt };
  }
  const held = readOpenClawStateLease(db, identity);
  if (!held) {
    throw new Error("Conflicting state lease disappeared inside its acquisition transaction");
  }
  // The owner token and recorded creation time identify this lease's grant, not liveness.
  return { kind: "held", holder: { owner: held.owner, epoch: held.createdAt } };
}

export function readOpenClawStateLease(
  db: DatabaseSync,
  identity: Pick<OpenClawStateLeaseIdentity, "scope" | "key">,
) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<LeaseDatabase>(db)
      .selectFrom("state_leases")
      .select([
        "owner",
        "created_at as createdAt",
        "expires_at as expiresAt",
        "payload_json as payloadJson",
      ])
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key),
  );
}

/** Reclaim only a same-host owner whose process identity is provably gone. */
export function reclaimDeadOpenClawStateLeaseInTransaction(
  db: DatabaseSync,
  identity: Pick<OpenClawStateLeaseIdentity, "scope" | "key">,
) {
  const existing = readOpenClawStateLease(db, identity);
  if (
    existing &&
    readStateLeaseProcessOwnerStatus(parseStateLeaseProcessOwner(existing.payloadJson)) === "dead"
  ) {
    releaseOpenClawStateLeaseInTransaction(db, { ...identity, owner: existing.owner });
    return undefined;
  }
  return existing;
}

export function readOpenClawStateLeaseExpiry(
  db: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
): number | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<LeaseDatabase>(db)
      .selectFrom("state_leases")
      .select("expires_at")
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key)
      .where("owner", "=", identity.owner)
      .where("expires_at", ">", Date.now())
      .$narrowType<{ expires_at: number }>(),
  )?.expires_at;
}

function repairMissingProcessStartTime(
  db: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
  processOwner: StateLeaseProcessOwner | undefined,
): string | undefined {
  if (processOwner?.startedAt == null) {
    return undefined;
  }
  const row = readOpenClawStateLease(db, identity);
  const recorded = parseStateLeaseProcessOwner(row?.payloadJson ?? null);
  if (
    row?.owner !== identity.owner ||
    recorded?.startedAt !== null ||
    recorded.pid !== processOwner.pid ||
    recorded.host !== processOwner.host ||
    !row.payloadJson
  ) {
    return undefined;
  }
  const payload: unknown = JSON.parse(row.payloadJson);
  if (!isRecord(payload) || !isRecord(payload.owner)) {
    return undefined;
  }
  return JSON.stringify({
    ...payload,
    owner: { ...payload.owner, startedAt: processOwner.startedAt },
  });
}

/** The caller owns the write transaction; expired or replaced owners cannot renew. */
export function renewOpenClawStateLeaseInTransaction(
  db: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
  leaseMs: number,
  processOwner?: StateLeaseProcessOwner,
): number | undefined {
  const now = Date.now();
  const expiresAt = now + leaseMs;
  const payloadJson = repairMissingProcessStartTime(db, identity, processOwner);
  const result = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<LeaseDatabase>(db)
      .updateTable("state_leases")
      .set({
        expires_at: expiresAt,
        heartbeat_at: now,
        updated_at: now,
        ...(payloadJson === undefined ? {} : { payload_json: payloadJson }),
      })
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key)
      .where("owner", "=", identity.owner)
      .where("expires_at", ">", now),
  );
  return result.numAffectedRows === 1n ? expiresAt : undefined;
}

/** The caller owns the write transaction; a replaced owner cannot release its successor. */
export function releaseOpenClawStateLeaseInTransaction(
  db: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<LeaseDatabase>(db)
      .deleteFrom("state_leases")
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key)
      .where("owner", "=", identity.owner),
  );
}
