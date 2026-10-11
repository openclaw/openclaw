import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "../../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import type { WorkerOperationContext } from "../../state/worker-operation-registry.js";
import {
  SessionWorktreeLifecycleError,
  SessionWorktreeSourceChangedError,
  WorktreeRemovalContentionError,
  registryAuthorityChanged,
} from "./errors.js";
import {
  publishPendingWorktreeInDatabase,
  recoverPendingWorktreesInDatabase,
} from "./pending-slots.worker.js";
import {
  worktreeRegistryPublication,
  withWorktreeRegistryWorkerReceipt,
} from "./registry-publication.js";
import {
  findLiveRegistryWorktreeByOwnerInDatabase,
  getRegistryWorktreeInDatabase,
  rowToRecord,
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
  const inserted = executeSqliteQuerySync(
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
      })
      .returningAll(),
  ).rows;
  worktreeRegistryPublication.rows(db, inserted);
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
  worktreeRegistryPublication.rows(db, executeSqliteQuerySync(db, update.returningAll()).rows);
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
  if (predicate.kind === "snapshot-retirement") {
    return assertSnapshotRetirementInDatabase(db, predicate.record);
  }
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
    case "live-binding":
      if (
        !current ||
        current.removedAt !== undefined ||
        (["ownerKind", "ownerId", "branch", "repoRoot"] as const).some(
          (key) => current[key] !== predicate.record[key],
        )
      ) {
        throw new SessionWorktreeLifecycleError(
          "Managed worktree binding authority changed.",
          "owner-mismatch",
        );
      }
      if (
        current.path !== predicate.record.path ||
        current.repoFingerprint !== predicate.record.repoFingerprint
      ) {
        throw new SessionWorktreeSourceChangedError("Managed worktree binding source changed.");
      }
      return;
    case "session-owner":
      if (
        current &&
        (current.ownerKind !== "session" || current.ownerId !== predicate.sessionKey)
      ) {
        throw registryAuthorityChanged(predicate.kind);
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
        throw registryAuthorityChanged(predicate.kind);
      }
      return;
    case "activity":
      if (current?.lastActiveAt !== predicate.lastActiveAt) {
        throw registryAuthorityChanged(predicate.kind);
      }
      return;
    case "record":
      if (JSON.stringify(current) !== JSON.stringify(predicate.record)) {
        throw registryAuthorityChanged(predicate.kind);
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
        throw registryAuthorityChanged(predicate.kind);
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
        throw registryAuthorityChanged(predicate.kind);
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
        throw registryAuthorityChanged(predicate.kind);
      }
      return;
    case "source-owner":
      if (
        current?.id !== predicate.id ||
        current.repoRoot !== predicate.repoRoot ||
        current.path !== predicate.path
      ) {
        throw registryAuthorityChanged(predicate.kind);
      }
      return;
    case "source-record":
      if (
        current?.ownerId !== predicate.ownerId ||
        current?.repoRoot !== predicate.repoRoot ||
        current?.repoFingerprint !== predicate.repoFingerprint
      ) {
        throw registryAuthorityChanged(predicate.kind);
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

/** Git equality cannot release provisioned bytes or a live lifecycle's recovery custody. */
function assertSnapshotRetirementInDatabase(
  db: DatabaseSync,
  observed: ManagedWorktreeRecord,
  reapStaleLeases = false,
): void {
  const k =
    getNodeSqliteKysely<
      Pick<DB, "worktrees" | "worktree_provisioned_file_chunks" | "state_leases">
    >(db);
  const row = executeSqliteQuerySync(
    db,
    k
      .selectFrom("worktrees")
      .selectAll("worktrees")
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom("worktree_provisioned_file_chunks")
              .select("worktree_id")
              .whereRef("worktree_id", "=", "worktrees.id"),
          )
          .as("has_chunks"),
      )
      .where("id", "=", observed.id),
  ).rows[0];
  if (
    observed.removedAt === undefined ||
    !row ||
    JSON.stringify(rowToRecord(row)) !== JSON.stringify(observed)
  ) {
    throw registryAuthorityChanged("snapshot-retirement");
  }
  const provisioned = safeParseJson(row.provisioned_paths_json ?? "");
  if (!Array.isArray(provisioned) || provisioned.length !== 0 || row.has_chunks) {
    throw new Error("Worktree snapshot retains provisioned data; retain its custody");
  }
  const leases = collectLiveRunLeases(db, k, worktreeRunLeaseScope(observed.id), reapStaleLeases);
  if (leases.liveCount !== 0 || leases.removingToken !== undefined) {
    throw new Error("Worktree snapshot has an active or unresolved run/removal consumer");
  }
}

export function deleteRegistryWorktreeInDatabase(
  db: DatabaseSync,
  input: { id: string; removalToken?: string; expectedRetired?: ManagedWorktreeRecord },
): void {
  if (input.expectedRetired) {
    if (input.expectedRetired.id !== input.id) {
      throw new Error("Worktree snapshot retirement ID changed");
    }
    assertSnapshotRetirementInDatabase(db, input.expectedRetired, true);
  }
  const k =
    getNodeSqliteKysely<
      Pick<DB, "worktrees" | "worktree_provisioned_file_chunks" | "state_leases">
    >(db);
  assertRegistryMutationCustody(db, k, input.id, input.removalToken);
  executeSqliteQuerySync(
    db,
    k.deleteFrom("worktree_provisioned_file_chunks").where("worktree_id", "=", input.id),
  );
  worktreeRegistryPublication.deleted(
    db,
    executeSqliteQuerySync(db, k.deleteFrom("worktrees").where("id", "=", input.id).returningAll())
      .rows,
  );
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
        withWorktreeRegistryWorkerReceipt(
          db,
          () => {
            mutate(db, input.value, input.leases);
            admit("commit");
          },
          input.receipt,
        );
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
  const inserted = executeSqliteQuerySync(
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
      )
      .returningAll(),
  ).rows;
  worktreeRegistryPublication.rows(db, inserted);
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
  const removed = executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("state_leases")
      .where("scope", "=", worktreeRunLeaseScope(input.worktreeId))
      .returning(["scope", "lease_key"]),
  ).rows;
  worktreeRegistryPublication.deleted(db, removed);
}

export function abortWorktreeRemovalInDatabase(
  db: DatabaseSync,
  input: { worktreeId: string; token: string },
): void {
  const removed = executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("state_leases")
      .where("scope", "=", worktreeRunLeaseScope(input.worktreeId))
      .where("lease_key", "=", WORKTREE_REMOVING_LEASE_KEY)
      .where("owner", "=", input.token)
      .returning(["scope", "lease_key"]),
  ).rows;
  worktreeRegistryPublication.deleted(db, removed);
}
