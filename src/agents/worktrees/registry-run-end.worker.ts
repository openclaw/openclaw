import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
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
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "../../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import type { WorkerOperationContext } from "../../state/worker-operation-registry.js";
import {
  SessionWorktreeLifecycleError,
  SessionWorktreeSourceChangedError,
  WorktreeRemovalContentionError,
  WorktreeRemovalLockError,
} from "./errors.js";
import {
  publishPendingWorktreeInDatabase,
  recoverPendingWorktreesInDatabase,
} from "./pending-slots.worker.js";
import {
  findLiveRegistryWorktreeByOwnerInDatabase,
  getRegistryWorktreeInDatabase,
} from "./registry-read.kernel.js";
import {
  assertRegistryMutationCustody,
  collectLiveRunLeases,
  worktreeRunLeaseScope,
  WORKTREE_REMOVING_LEASE_KEY,
} from "./run-lease-owner.js";
import type {
  ManagedWorktreeRecord,
  ProvisionedFileState,
  WorktreeRegistryPredicate,
} from "./types.js";

const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, "worktrees" | "state_leases">>(db);

export type WorktreeRegistryPatch = Partial<
  Pick<ManagedWorktreeRecord, "lastActiveAt" | "removedAt" | "runEndCleanup" | "snapshotRef">
> & {
  repositoryIdentity?: Pick<ManagedWorktreeRecord, "repoRoot" | "repoFingerprint">;
  provisionedPaths?: readonly string[];
  provisionedState?: readonly ProvisionedFileState[];
};

export function insertRegistryWorktreeInDatabase(
  db: DatabaseSync,
  {
    record,
    provisionedPaths,
    pendingId,
  }: {
    record: ManagedWorktreeRecord;
    provisionedPaths?: readonly string[];
    pendingId?: string;
  },
  leases?: readonly OpenClawStateLeaseIdentity[],
): void {
  if (pendingId !== undefined) {
    publishPendingWorktreeInDatabase(db, pendingId, record, leases);
  }
  executeSqliteQuerySync(
    db,
    query(db)
      .insertInto("worktrees")
      .values({
        id: record.id,
        repo_fingerprint: record.repoFingerprint,
        repo_root: record.repoRoot,
        path: record.path,
        branch: record.branch,
        base_ref: record.baseRef,
        owner_kind: record.ownerKind,
        owner_id: record.ownerId ?? null,
        snapshot_ref: record.snapshotRef ?? null,
        created_at: record.createdAt,
        last_active_at: record.lastActiveAt,
        removed_at: record.removedAt ?? null,
        gc_protection_json: null,
        provisioned_paths_json:
          provisionedPaths === undefined ? null : JSON.stringify(provisionedPaths),
        run_end_cleanup_json:
          record.runEndCleanup === undefined ? null : JSON.stringify(record.runEndCleanup),
      }),
  );
}

export function updateRegistryWorktreeInDatabase(
  db: DatabaseSync,
  input: {
    id: string;
    patch: WorktreeRegistryPatch;
    onlyIfLive?: boolean;
    onlyIfActiveAt?: number;
    removalToken?: string;
  },
): void {
  const { id, patch } = input;
  const values: Partial<Selectable<DB["worktrees"]>> = {};
  if (patch.lastActiveAt !== undefined) {
    values.last_active_at = patch.lastActiveAt;
  }
  if ("removedAt" in patch) {
    values.removed_at = patch.removedAt ?? null;
  }
  if ("snapshotRef" in patch) {
    values.snapshot_ref = patch.snapshotRef ?? null;
  }
  if ("runEndCleanup" in patch) {
    values.run_end_cleanup_json =
      patch.runEndCleanup === undefined ? null : JSON.stringify(patch.runEndCleanup);
  }
  if (patch.repositoryIdentity) {
    values.repo_root = patch.repositoryIdentity.repoRoot;
    values.repo_fingerprint = patch.repositoryIdentity.repoFingerprint;
  }
  if (patch.provisionedState !== undefined) {
    values.provisioned_paths_json = JSON.stringify(patch.provisionedState);
  } else if (patch.provisionedPaths !== undefined) {
    values.provisioned_paths_json = JSON.stringify(patch.provisionedPaths);
  }
  assertRegistryMutationCustody(db, query(db), id, input.removalToken);
  let update = query(db).updateTable("worktrees").set(values).where("id", "=", id);
  // Retained/failed outcomes belong only to the observed live lifecycle.
  if (input.onlyIfLive) {
    update = update.where("removed_at", "is", null);
  }
  if (input.onlyIfActiveAt !== undefined) {
    update = update.where("last_active_at", "=", input.onlyIfActiveAt);
  }
  executeSqliteQuerySync(db, update);
}

export type WorktreeRunEndInput<T> = {
  value: T;
  receipt: string;
  leases?: readonly OpenClawStateLeaseIdentity[];
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

export function assertWorktreeRegistryPredicates(
  db: DatabaseSync,
  predicates: readonly WorktreeRegistryPredicate[] = [],
): void {
  for (const predicate of predicates) {
    assertPredicate(db, predicate);
  }
}

export function worktreeRunEndMutation<Input>(
  operationLabel: string,
  mutate: (db: DatabaseSync, input: Input, leases?: readonly OpenClawStateLeaseIdentity[]) => void,
) {
  return (input: WorktreeRunEndInput<Input>, context: WorkerOperationContext): void => {
    const database = context.open();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const admit = (stage: "transaction" | "commit") => {
          if (input.leases) {
            assertOpenClawStateLeasesWorkerOwnedInTransaction(db, input.leases, stage);
          } else {
            requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
          }
        };
        admit("transaction");
        assertWorktreeRegistryPredicates(db, input.predicates);
        mutate(db, input.value, input.leases);
        admit("commit");
        deferSqliteWorkerCommitReceipt(db, input.receipt);
      },
      { ...context.stateOptions(), database },
      { operationLabel },
    );
  };
}

export const recoverPendingWorktreesInWorker = worktreeRunEndMutation(
  "worktrees.recoverPending",
  recoverPendingWorktreesInDatabase,
);

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
