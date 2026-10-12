import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { Value } from "typebox/value";
import { WorktreeRecordSchema } from "../../../packages/gateway-protocol/src/schema/worktrees.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  parseStateLeaseProcessOwner,
  readStateLeaseProcessOwnerStatus,
  type StateLeaseProcessOwner,
} from "../../infra/state-lease-process-owner.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import { WORKTREE_CREATE_LEASE_SCOPE, WORKTREE_MUTATION_LEASE_SCOPE } from "./capacity-contract.js";
import { listRegistryWorktreesInDatabase } from "./registry-read.kernel.js";
import type { ManagedWorktreeRecord } from "./types.js";

const PENDING_SCOPE = "core:managed-worktrees:pending-slots";
const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, "state_leases" | "worktrees">>(db);

export type PendingWorktreeSlot = {
  record: ManagedWorktreeRecord;
  state: "pending" | "recovering";
};

function readSlots(db: DatabaseSync) {
  return executeSqliteQuerySync(
    db,
    query(db).selectFrom("state_leases").selectAll().where("scope", "=", PENDING_SCOPE),
  ).rows.map(decodeSlot);
}

function decodeSlot(row: {
  lease_key: string;
  owner: string | null;
  payload_json: string | null;
}): {
  record: ManagedWorktreeRecord;
  state: PendingWorktreeSlot["state"];
  owner: StateLeaseProcessOwner | null;
} {
  const payload = safeParseJsonRecord(row.payload_json ?? "");
  const record = payload?.record;
  const state = payload?.state;
  if (
    !isPendingRecord(record) ||
    record.id !== row.lease_key ||
    record.id !== row.owner ||
    record.removedAt !== undefined ||
    (state !== "pending" && state !== "recovering")
  ) {
    throw new Error(`Invalid pending worktree slot: ${row.lease_key}; run Doctor before creating`);
  }
  return { record, state, owner: parseStateLeaseProcessOwner(row.payload_json) };
}

function isPendingRecord(value: unknown): value is ManagedWorktreeRecord {
  return Value.Check(WorktreeRecordSchema, value);
}

/** One statement observes publication as either pending or live, never neither or both. */
export function readWorktreeSlotCountInDatabase(db: DatabaseSync): number {
  const k = query(db);
  const rows = executeSqliteQuerySync(
    db,
    k
      .selectFrom("worktrees")
      .select((eb) => [
        "id",
        eb.val("live").as("kind"),
        eb.val<string | null>(null).as("owner"),
        eb.val<string | null>(null).as("payload_json"),
      ])
      .where("removed_at", "is", null)
      .unionAll(
        k
          .selectFrom("state_leases")
          .select((eb) => ["lease_key as id", eb.val("slot").as("kind"), "owner", "payload_json"])
          .where("scope", "=", PENDING_SCOPE),
      ),
  ).rows;
  return rows.reduce(
    (count, row) =>
      count +
      (row.kind === "live" || decodeSlot({ ...row, lease_key: row.id }).state === "pending"
        ? 1
        : 0),
    0,
  );
}

export function readPendingWorktreesInDatabase(db: DatabaseSync): PendingWorktreeSlot[] {
  return readSlots(db).map(({ record, state }) => ({ record, state }));
}

function assertPendingWorktreeMutationLease(
  id: string,
  leases: readonly OpenClawStateLeaseIdentity[] = [],
): void {
  if (!leases.some((lease) => lease.scope === WORKTREE_MUTATION_LEASE_SCOPE && lease.key === id)) {
    throw new Error("Pending worktree mutation requires its retained checkout lease");
  }
}

export function reservePendingWorktreeInDatabase(
  db: DatabaseSync,
  value: { record: ManagedWorktreeRecord; owner: StateLeaseProcessOwner },
  leases: readonly OpenClawStateLeaseIdentity[] = [],
): void {
  const { record } = value;
  assertPendingWorktreeMutationLease(record.id, leases);
  if (
    !leases.some((lease) => lease.scope === WORKTREE_CREATE_LEASE_SCOPE && lease.key === "capacity")
  ) {
    throw new Error("Pending worktree reservation requires the allocation lease");
  }
  const slots = [
    ...readSlots(db),
    ...listRegistryWorktreesInDatabase(db, { liveOnly: true }).map((current) => ({
      record: current,
      state: "pending",
    })),
  ];
  if (
    slots.some(
      ({ record: current, state }) =>
        current.id === record.id ||
        current.path === record.path ||
        (current.repoFingerprint === record.repoFingerprint && current.name === record.name) ||
        (state !== "recovering" &&
          record.ownerId !== undefined &&
          current.ownerKind === record.ownerKind &&
          current.ownerId === record.ownerId),
    )
  ) {
    throw new Error("Managed worktree name or owner already has a live or pending checkout");
  }
  executeSqliteQuerySync(
    db,
    query(db)
      .insertInto("state_leases")
      .values({
        scope: PENDING_SCOPE,
        lease_key: record.id,
        owner: record.id,
        expires_at: null,
        heartbeat_at: null,
        payload_json: JSON.stringify({ ...value, state: "pending" }),
        created_at: record.createdAt,
        updated_at: record.createdAt,
      }),
  );
}

export function recoverPendingWorktreesInDatabase(
  db: DatabaseSync,
  _input: undefined,
  leases: readonly OpenClawStateLeaseIdentity[] = [],
): void {
  if (
    !leases.some((lease) => lease.scope === WORKTREE_CREATE_LEASE_SCOPE && lease.key === "capacity")
  ) {
    throw new Error("Pending worktree recovery requires the allocation lease");
  }
  for (const slot of readSlots(db)) {
    if (slot.state !== "pending" || readStateLeaseProcessOwnerStatus(slot.owner) !== "dead") {
      continue;
    }
    // Reclaim admission only: native children may still write the retained checkout.
    executeSqliteQuerySync(
      db,
      query(db)
        .updateTable("state_leases")
        .set({
          payload_json: JSON.stringify({ ...slot, state: "recovering" }),
          updated_at: Date.now(),
        })
        .where("scope", "=", PENDING_SCOPE)
        .where("lease_key", "=", slot.record.id)
        .where("owner", "=", slot.record.id),
    );
  }
}

export function releasePendingWorktreeInDatabase(
  db: DatabaseSync,
  { id }: { id: string },
  leases: readonly OpenClawStateLeaseIdentity[] = [],
): void {
  assertPendingWorktreeMutationLease(id, leases);
  executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("state_leases")
      .where("scope", "=", PENDING_SCOPE)
      .where("lease_key", "=", id)
      .where("owner", "=", id),
  );
}

export function publishPendingWorktreeInDatabase(
  db: DatabaseSync,
  id: string,
  record: ManagedWorktreeRecord,
  leases: readonly OpenClawStateLeaseIdentity[] = [],
): void {
  const slot = readSlots(db).find((candidate) => candidate.record.id === id);
  // Remote base-ref resolution can finish after reservation; checkout identity stays fixed.
  if (
    !slot ||
    slot.state !== "pending" ||
    (
      [
        "id",
        "path",
        "name",
        "ownerKind",
        "ownerId",
        "repoRoot",
        "repoFingerprint",
        "branch",
        "createdAt",
      ] as const
    ).some((key) => slot.record[key] !== record[key])
  ) {
    throw new Error("Pending worktree identity changed before publication");
  }
  releasePendingWorktreeInDatabase(db, { id }, leases);
}
