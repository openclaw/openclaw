import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "../../infra/disk-space.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  parseStateLeaseProcessOwner,
  readStateLeaseProcessOwnerStatus,
} from "../../infra/state-lease-process-owner.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "../../state/openclaw-state-lease-worker.js";
import type { WorkerOperationContext } from "../../state/worker-operation-registry.js";
import {
  WORKTREE_CREATE_LEASE_SCOPE,
  WORKTREE_MUTATION_LEASE_SCOPE,
  WORKTREE_CAPACITY_RESERVATION_SCOPE,
  type WorktreeCapacityRequest,
  type WorktreeCapacityResult,
  type WorktreeCapacityWorkerInput,
} from "./capacity-contract.js";
import { assertWorktreeRegistryPredicates } from "./registry-run-end.worker.js";

const GiB = 1024 ** 3;

type WorktreeVolumeReservation = { device: string; bytes: number; reserve: number };

function readReservations(payload: Record<string, unknown>): WorktreeVolumeReservation[] {
  const entries = payload.worktreeCapacity;
  if (entries === undefined) {
    return [];
  }
  if (!Array.isArray(entries)) {
    throw new Error(
      "Managed worktree capacity reservation is unreadable; retry after its owner settles.",
    );
  }
  return entries.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.device !== "string" ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.reserve !== "number" ||
      !Number.isSafeInteger(entry.reserve) ||
      entry.reserve < 0
    ) {
      throw new Error(
        "Managed worktree capacity reservation is unreadable; retry after its owner settles.",
      );
    }
    return { device: entry.device, bytes: entry.bytes, reserve: entry.reserve };
  });
}

function measureVolumes(demands: readonly { path: string; bytes: number }[]) {
  const volumes = new Map<number, { path: string; available: number; bytes: number }>();
  for (const demand of demands) {
    const space = tryReadDiskSpace(demand.path);
    if (!space || space.totalBytes === null) {
      throw new Error(
        `Cannot determine disk space near ${demand.path}; check the volume and retry worktree allocation.`,
      );
    }
    const device = statSync(space.checkedPath).dev;
    const existing = volumes.get(device);
    if (existing) {
      existing.available = Math.min(existing.available, space.availableBytes);
      existing.bytes += demand.bytes;
    } else {
      volumes.set(device, {
        path: space.checkedPath,
        available: space.availableBytes,
        bytes: demand.bytes,
      });
    }
  }
  return volumes;
}

/** The writer transaction samples disk and accounts for every retained operation before admitting writes. */
function reserveWorktreeCapacityInDatabase(
  db: DatabaseSync,
  input: WorktreeCapacityRequest,
): WorktreeCapacityResult {
  const { key, owner, demands, purpose, snapshot } = input;
  const volumes = measureVolumes(demands);
  const k = getNodeSqliteKysely<Pick<DB, "state_leases">>(db);
  const rows = executeSqliteQuerySync(
    db,
    k
      .selectFrom("state_leases")
      .select(["lease_key", "owner", "heartbeat_at", "payload_json"])
      .where("scope", "=", WORKTREE_CAPACITY_RESERVATION_SCOPE),
  ).rows;
  const pending = new Map<string, { bytes: number; reserve: number; key: string }>();
  const now = Date.now();
  for (const row of rows) {
    if (row.lease_key === key && row.owner === key) {
      continue;
    }
    if (
      readStateLeaseProcessOwnerStatus(
        parseStateLeaseProcessOwner(row.payload_json),
        row.heartbeat_at ?? undefined,
      ) === "dead"
    ) {
      executeSqliteQuerySync(
        db,
        k
          .deleteFrom("state_leases")
          .where("scope", "=", WORKTREE_CAPACITY_RESERVATION_SCOPE)
          .where("lease_key", "=", row.lease_key)
          .where("owner", "=", row.owner),
      );
      continue;
    }
    const payload: unknown = row.payload_json === null ? {} : JSON.parse(row.payload_json);
    if (!isRecord(payload)) {
      throw new Error(
        "Managed worktree capacity lease is unreadable; retry after its owner settles.",
      );
    }
    for (const reservation of readReservations(payload)) {
      const previous = pending.get(reservation.device);
      pending.set(reservation.device, {
        bytes: (previous?.bytes ?? 0) + reservation.bytes,
        reserve: Math.max(previous?.reserve ?? 0, reservation.reserve),
        key: previous?.key ?? row.lease_key,
      });
    }
  }
  const reserve = snapshot ? 128 * 1024 ** 2 : 4 * GiB;
  const reservations: WorktreeVolumeReservation[] = [];
  for (const [device, volume] of volumes) {
    const other = pending.get(String(device));
    const required = Math.max(reserve, other?.reserve ?? 0) + volume.bytes + (other?.bytes ?? 0);
    if (!Number.isSafeInteger(Math.ceil(required)) || volume.available < required) {
      const message = `Insufficient disk space near ${volume.path} for ${purpose}: ${formatDiskSpaceBytes(volume.available)} available; approximately ${formatDiskSpaceBytes(required)} required including safety reserve and pending managed worktree writes. Wait for cleanup or free caches, then retry.`;
      return { admitted: false, message, ...(other ? { reservationKey: other.key } : {}) };
    }
    reservations.push({ device: String(device), bytes: Math.ceil(volume.bytes), reserve });
  }
  const admission = executeSqliteQuerySync(
    db,
    k
      .insertInto("state_leases")
      .values({
        scope: WORKTREE_CAPACITY_RESERVATION_SCOPE,
        lease_key: key,
        owner: key,
        expires_at: null,
        heartbeat_at: null,
        payload_json: JSON.stringify({ owner, worktreeCapacity: reservations }),
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["scope", "lease_key"])
          .doUpdateSet({
            payload_json: JSON.stringify({ owner, worktreeCapacity: reservations }),
            updated_at: now,
          })
          .where("owner", "=", key),
      ),
  );
  if (admission.numAffectedRows !== 1n) {
    throw new Error("Managed worktree capacity reservation changed");
  }
  return { admitted: true };
}

export function reserveWorktreeCapacityInWorker(
  input: WorktreeCapacityWorkerInput,
  context: WorkerOperationContext,
): WorktreeCapacityResult {
  const { leases } = input;
  if (
    !leases.every(
      (lease) =>
        (lease.scope === WORKTREE_CREATE_LEASE_SCOPE && lease.key === "capacity") ||
        lease.scope === WORKTREE_MUTATION_LEASE_SCOPE,
    )
  ) {
    throw new Error("Worktree capacity requires its allocation owner");
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertOpenClawStateLeasesWorkerOwnedInTransaction(db, leases);
      assertWorktreeRegistryPredicates(db, input.predicates);
      const result = reserveWorktreeCapacityInDatabase(db, input);
      assertOpenClawStateLeasesWorkerOwnedInTransaction(db, leases, "commit");
      return result;
    },
    { ...context.stateOptions(), database: context.open() },
    { operationLabel: "agents.worktrees.capacity-admit" },
  );
}
