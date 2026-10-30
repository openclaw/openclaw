import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  parseStateLeaseProcessOwner,
  readStateLeaseProcessOwnerStatus,
  type StateLeaseProcessOwner,
} from "../infra/state-lease-process-owner.js";
import { StateLeaseLossSchema, type StateLeaseLoss } from "../shared/state-lease-loss.js";
import type { DB } from "./openclaw-state-db.generated.js";
import type {
  OpenClawStateLeaseIdentity,
  OpenClawStateLeaseAcquisition,
} from "./openclaw-state-lease.types.js";

type LeaseDatabase = Pick<DB, "state_leases">;

/** Publish owner facts in the caller's transaction without renewing or replacing its lease. */
export function updateOpenClawStateLeasePayloadInTransaction(
  db: EngineConnection,
  identity: OpenClawStateLeaseIdentity,
  payloadJson: string,
): boolean {
  const result = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<LeaseDatabase>(db)
      .updateTable("state_leases")
      .set({ payload_json: payloadJson })
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key)
      .where("owner", "=", identity.owner),
  );
  return result.numAffectedRows === 1n;
}

/** The caller owns the write transaction; only absent or expired leases can be acquired. */
export function acquireOpenClawStateLeaseInTransaction(
  db: EngineConnection,
  identity: OpenClawStateLeaseIdentity,
  leaseMs: number,
  payloadJson: string | null = null,
  nowMs?: number,
): OpenClawStateLeaseAcquisition {
  // Unless the caller owns a captured clock, sample after transaction admission:
  // BEGIN IMMEDIATE may wait long enough to exhaust a lease sampled beforehand.
  const now = nowMs ?? Date.now();
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
  return {
    kind: "held",
    holder: { owner: held.owner, epoch: held.createdAt, expiresAt: held.expiresAt },
  };
}

export function readOpenClawStateLease(
  db: EngineConnection,
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
        "heartbeat_at as heartbeatAt",
        "payload_json as payloadJson",
      ])
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key),
  );
}

/** Observe only after authority has failed; diagnostics must never replace that failure. */
export function readOpenClawStateLeaseLoss(
  db: EngineConnection,
  identity: OpenClawStateLeaseIdentity,
): StateLeaseLoss | undefined {
  try {
    const row = readOpenClawStateLease(db, identity);
    const now = Date.now();
    const loss = !row
      ? { reason: "missing" }
      : row.owner !== identity.owner
        ? { reason: "replaced", owner: "[redacted]" }
        : row.expiresAt !== null && row.heartbeatAt !== null && row.expiresAt <= now
          ? {
              reason: "expired",
              expiresAt: row.expiresAt,
              expiredByMs: now - row.expiresAt,
              heartbeatAgeMs: Math.max(0, now - row.heartbeatAt),
            }
          : undefined;
    return StateLeaseLossSchema.safeParse(loss).data;
  } catch {
    return undefined;
  }
}

/** Reclaim only a same-host owner whose process identity is provably gone. */
export function reclaimDeadOpenClawStateLeaseInTransaction(
  db: EngineConnection,
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
  db: EngineConnection,
  identity: OpenClawStateLeaseIdentity,
  nowMs?: number,
): number | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<LeaseDatabase>(db)
      .selectFrom("state_leases")
      .select("expires_at")
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key)
      .where("owner", "=", identity.owner)
      .where("expires_at", ">", nowMs ?? Date.now())
      .$narrowType<{ expires_at: number }>(),
  )?.expires_at;
}

function repairMissingProcessStartTime(
  db: EngineConnection,
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
  db: EngineConnection,
  identity: OpenClawStateLeaseIdentity,
  leaseMs: number,
  processOwner?: StateLeaseProcessOwner,
  nowMs?: number,
): number | undefined {
  const now = nowMs ?? Date.now();
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

/** Renew an unchanged grant while its owner excludes takeover with SQLite's writer lock. */
export function renewOpenClawStateLeaseUnderWriteFence(
  db: EngineConnection,
  identity: OpenClawStateLeaseIdentity,
  acquiredAt: number,
  leaseMs: number,
): number | undefined {
  const now = Date.now();
  const expiresAt = now + leaseMs;
  // Only the owner retaining SQLite's writer across a native COMMIT may renew
  // past expiry. Both the owner token and the original grant must still match.
  const result = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<LeaseDatabase>(db)
      .updateTable("state_leases")
      .set({ expires_at: expiresAt, heartbeat_at: now, updated_at: now })
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key)
      .where("owner", "=", identity.owner)
      .where("created_at", "=", acquiredAt),
  );
  return result.numAffectedRows === 1n ? expiresAt : undefined;
}

/** The caller owns write admission; a replaced owner cannot release its successor. */
export function releaseOpenClawStateLeaseInTransaction(
  db: EngineConnection,
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
