import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import type { WorkerOperationContext } from "../../state/worker-operation-registry.js";
import {
  SessionWorktreeLifecycleError,
  SessionWorktreeSourceChangedError,
  WorktreeRemovalContentionError,
  WorktreeRemovalLockError,
} from "./errors.js";
import {
  findLiveRegistryWorktreeByOwnerInDatabase,
  getRegistryWorktreeInDatabase,
} from "./registry-read.kernel.js";
import {
  collectLiveRunLeases,
  worktreeRunLeaseScope,
  WORKTREE_REMOVING_LEASE_KEY,
} from "./run-lease-owner.js";
import type { WorktreeRegistryPredicate } from "./types.js";

const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, "worktrees" | "state_leases">>(db);
export type WorktreeRunEndInput<T> = {
  value: T;
  receipt: string;
  lease?: OpenClawStateLeaseIdentity;
  predicates?: readonly WorktreeRegistryPredicate[];
};

function assertRemovalToken(db: DatabaseSync, id: string, token: string) {
  const row = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("state_leases")
      .select("owner")
      .where("scope", "=", worktreeRunLeaseScope(id))
      .where("lease_key", "=", WORKTREE_REMOVING_LEASE_KEY),
  ).rows[0];
  if (row?.owner !== token) {
    throw new WorktreeRemovalContentionError(
      "busy",
      "Worktree removal claim changed; checkout preserved",
    );
  }
}

function assertPredicate(db: DatabaseSync, predicate: WorktreeRegistryPredicate) {
  if (predicate.kind === "removal-claim") {
    return assertRemovalToken(db, predicate.id, predicate.token);
  }
  if (predicate.kind === "removal-claims") {
    const ids = [...new Set(predicate.ids)];
    if (ids.length === 0) {
      return;
    }
    const held = executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("state_leases")
        .select((eb) => eb.fn.countAll<number>().as("held"))
        .where("scope", "in", sqliteStringSet(ids.map(worktreeRunLeaseScope)))
        .where("lease_key", "=", WORKTREE_REMOVING_LEASE_KEY)
        .where("owner", "=", predicate.token),
    ).rows[0]?.held;
    if (held !== ids.length) {
      throw new WorktreeRemovalContentionError(
        "busy",
        "Worktree removal claim changed; checkout preserved",
      );
    }
    return;
  }
  const observed = "record" in predicate ? predicate.record : predicate;
  const current =
    predicate.kind === "source-owner"
      ? findLiveRegistryWorktreeByOwnerInDatabase(db, "session", predicate.ownerId)
      : getRegistryWorktreeInDatabase(db, observed.id);
  switch (predicate.kind) {
    case "session-owner":
      if (
        current &&
        (current.ownerKind !== "session" || current.ownerId !== predicate.sessionKey)
      ) {
        throw new SessionWorktreeLifecycleError(
          "Session worktree ownership changed; retry cleanup.",
          "owner-mismatch",
        );
      }
      return;
    case "binding":
      if (
        !current ||
        (
          [
            "path",
            "repoRoot",
            "repoFingerprint",
            "branch",
            "baseRef",
            "ownerKind",
            "ownerId",
            "createdAt",
            "lastActiveAt",
            "removedAt",
          ] as const
        ).some((key) => current[key] !== predicate.record[key])
      ) {
        throw new WorktreeRemovalContentionError(
          "busy",
          "Worktree owner or binding changed; checkout preserved",
        );
      }
      return;
    case "activity":
      if (current?.lastActiveAt !== predicate.lastActiveAt) {
        throw new WorktreeRemovalLockError("busy", "worktree activity changed during cleanup");
      }
      return;
    case "record":
      if (JSON.stringify(current) !== JSON.stringify(predicate.record)) {
        throw new Error(
          "Worktree registry changed during recovery; remaining source and original snapshot preserved",
        );
      }
      return;
    case "exact-snapshot": {
      const record = predicate.record;
      if (
        !current ||
        current.ownerKind !== record.ownerKind ||
        current.ownerId !== record.ownerId ||
        current.createdAt !== record.createdAt ||
        current.lastActiveAt !== record.lastActiveAt ||
        current.removedAt !== record.removedAt ||
        current.path !== record.path ||
        current.repoRoot !== record.repoRoot ||
        current.repoFingerprint !== record.repoFingerprint ||
        current.branch !== record.branch ||
        current.snapshotRef !== record.snapshotRef
      ) {
        throw new Error(
          "Exact-state recovery owner or lifecycle changed; source and snapshot preserved",
        );
      }
      return;
    }
    case "exact-owner": {
      const record = predicate.record;
      if (
        !current ||
        current.removedAt !== undefined ||
        current.ownerKind !== record.ownerKind ||
        current.ownerId !== record.ownerId ||
        current.createdAt !== record.createdAt ||
        current.lastActiveAt !== record.lastActiveAt
      ) {
        throw new Error("Worktree exact-state owner or lifecycle changed; checkout preserved");
      }
      if (
        current.path !== record.path ||
        current.branch !== record.branch ||
        current.repoRoot !== record.repoRoot
      ) {
        throw new Error("Worktree exact-state binding changed; checkout preserved");
      }
      return;
    }
    case "projection":
      if (
        !current ||
        current.ownerKind !== "session" ||
        current.ownerId !== predicate.ownerId ||
        current.path !== predicate.path ||
        current.repoRoot !== predicate.repoRoot
      ) {
        throw new Error("Managed projection owner changed during settlement");
      }
      return;
    case "source-owner":
      if (
        current?.id !== predicate.id ||
        current.repoRoot !== predicate.repoRoot ||
        current.path !== predicate.path
      ) {
        throw new SessionWorktreeSourceChangedError(
          "Spawn parent managed worktree changed; retry from its current session",
        );
      }
      return;
    case "source-record":
      if (
        current?.ownerId !== predicate.ownerId ||
        current?.repoRoot !== predicate.repoRoot ||
        current?.repoFingerprint !== predicate.repoFingerprint
      ) {
        throw new SessionWorktreeSourceChangedError(
          "Accepted managed source changed during preparation",
        );
      }
  }
}

export function worktreeRunEndMutation<Input>(
  operationLabel: string,
  mutate: (db: DatabaseSync, input: Input) => void,
) {
  return (input: WorktreeRunEndInput<Input>, context: WorkerOperationContext): void => {
    const database = context.open();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const admit = (stage: "transaction" | "commit") => {
          if (input.lease) {
            assertOpenClawStateLeaseWorkerOwnedInTransaction(db, input.lease, "write", stage);
          } else {
            requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
          }
        };
        admit("transaction");
        for (const predicate of input.predicates ?? []) {
          assertPredicate(db, predicate);
        }
        mutate(db, input.value);
        admit("commit");
        deferSqliteWorkerCommitReceipt(db, input.receipt);
      },
      { ...context.stateOptions(), database },
      { operationLabel },
    );
  };
}

export type WorktreeRemovalRowInput = {
  worktreeId: string;
  token: string;
  pid: number;
  startTime: number | null;
  now: number;
  retiredExact?: true;
  retiredRemoval?: true;
};
export function claimWorktreeRemovalInDatabase(
  db: DatabaseSync,
  params: WorktreeRemovalRowInput,
): void {
  const k = query(db);
  const scope = worktreeRunLeaseScope(params.worktreeId);
  const record = executeSqliteQuerySync(
    db,
    k
      .selectFrom("worktrees")
      .select(["id", "path", "removed_at", "snapshot_ref"])
      .where("id", "=", params.worktreeId),
  ).rows[0];
  if (
    !record ||
    (params.retiredRemoval
      ? record.removed_at == null ||
        record.snapshot_ref !== `refs/openclaw/snapshots/${params.worktreeId}`
      : params.retiredExact
        ? record.removed_at == null ||
          !record.snapshot_ref?.startsWith("refs/openclaw/snapshots/exact-")
        : record.removed_at != null)
  ) {
    throw new WorktreeRemovalContentionError(
      "finalized",
      `managed worktree was removed: ${record?.path ?? params.worktreeId}`,
    );
  }
  const { livePids, removingToken } = collectLiveRunLeases(db, k, scope);
  if (livePids.length > 0) {
    throw new WorktreeRemovalContentionError(
      "busy",
      `worktree is busy: locked by live pid ${livePids[0]}`,
      { worktreeId: params.worktreeId, pid: livePids[0]! },
    );
  }
  if (removingToken !== undefined && removingToken !== params.token) {
    throw new WorktreeRemovalContentionError("busy", "worktree removal is already in progress");
  }
  const payloadJson = JSON.stringify({ pid: params.pid, starttime: params.startTime ?? undefined });
  executeSqliteQuerySync(
    db,
    k
      .insertInto("state_leases")
      .values({
        scope,
        lease_key: WORKTREE_REMOVING_LEASE_KEY,
        owner: params.token,
        expires_at: null,
        heartbeat_at: null,
        payload_json: payloadJson,
        created_at: params.now,
        updated_at: params.now,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["scope", "lease_key"])
          .doUpdateSet({ owner: params.token, payload_json: payloadJson, updated_at: params.now }),
      ),
  );
}

export type WorktreeRemovalFinalization = {
  worktreeId: string;
  lastActiveAt: number;
  removedAt?: number;
  token?: string;
};
export function finalizeWorktreeRemovalInDatabase(
  db: DatabaseSync,
  input: WorktreeRemovalFinalization,
): void {
  const record = getRegistryWorktreeInDatabase(db, input.worktreeId);
  if (
    !record ||
    record.lastActiveAt !== input.lastActiveAt ||
    record.removedAt !== input.removedAt
  ) {
    throw new WorktreeRemovalContentionError("finalized", "Worktree removal lifecycle changed");
  }
  if (input.token) {
    assertRemovalToken(db, input.worktreeId, input.token);
  }
  executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("state_leases")
      .where("scope", "=", worktreeRunLeaseScope(input.worktreeId)),
  );
}

export function abortWorktreeRemovalInDatabase(
  db: DatabaseSync,
  input: { worktreeId: string; token: string },
): void {
  executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("state_leases")
      .where("scope", "=", worktreeRunLeaseScope(input.worktreeId))
      .where("lease_key", "=", WORKTREE_REMOVING_LEASE_KEY)
      .where("owner", "=", input.token),
  );
}
