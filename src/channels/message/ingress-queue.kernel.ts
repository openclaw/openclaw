import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { FAILED_NULL_PAYLOAD_SENTINEL } from "./ingress-queue.codec.js";

const getQueue = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);

type ChannelIngressMutation = {
  queueName: string;
  id: string;
  token: string | null;
  now: number;
};

function selectedMutation(db: DatabaseSync, input: ChannelIngressMutation) {
  const base = getQueue(db)
    .updateTable("channel_ingress_events")
    .where("queue_name", "=", input.queueName)
    .where("event_id", "=", input.id);
  return input.token === null
    ? base.where("status", "=", "pending")
    : base.where("status", "=", "claimed").where("claim_token", "=", input.token);
}

export function refreshChannelIngressClaimInDatabase(
  db: DatabaseSync,
  input: ChannelIngressMutation,
): boolean {
  return (
    affectedRows(
      executeSqliteQuerySync(
        db,
        selectedMutation(db, input).set({ claimed_at: input.now, updated_at: input.now }),
      ),
    ) > 0
  );
}

export function releaseChannelIngressInDatabase(
  db: DatabaseSync,
  input: ChannelIngressMutation & { recordAttempt?: boolean; lastError?: string },
): boolean {
  return (
    affectedRows(
      executeSqliteQuerySync(
        db,
        selectedMutation(db, input).set((eb) => ({
          status: "pending",
          claim_token: null,
          claim_owner: null,
          claimed_at: null,
          // A claim can lose its owner before processing starts. Returning it
          // must not consume retry budget or erase the previous real failure.
          ...(input.recordAttempt === false
            ? {}
            : { attempts: eb("attempts", "+", 1), last_attempt_at: input.now }),
          ...(input.lastError === undefined ? {} : { last_error: input.lastError }),
          updated_at: input.now,
        })),
      ),
    ) > 0
  );
}

export function failChannelIngressInDatabase(
  db: DatabaseSync,
  input: ChannelIngressMutation & { reason: string; message?: string },
): boolean {
  return (
    affectedRows(
      executeSqliteQuerySync(
        db,
        selectedMutation(db, input).set((eb) => ({
          status: "failed",
          failed_at: input.now,
          failed_reason: input.reason,
          last_error: input.message ?? null,
          payload_json: eb
            .case()
            .when("payload_json", "=", "null")
            .then(FAILED_NULL_PAYLOAD_SENTINEL)
            .else(eb.ref("payload_json"))
            .end(),
          claim_token: null,
          claim_owner: null,
          claimed_at: null,
          updated_at: input.now,
        })),
      ),
    ) > 0
  );
}

export function listChannelIngressAccountsInDatabase(
  db: DatabaseSync,
  input: { channelId: string },
): string[] {
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db)
      .selectFrom("channel_ingress_events")
      .select("account_id")
      .distinct()
      .where("channel_id", "=", input.channelId)
      .orderBy("account_id", "asc"),
  ).rows.map((row) => row.account_id);
}

export type ChannelIngressPruneInput = {
  queueName: string;
  pendingCutoff: number | null;
  completedCutoff: number | null;
  failedCutoff: number | null;
  pendingMaxEntries: number | null;
  completedMaxEntries: number | null;
  failedMaxEntries: number | null;
  protectIds: string[];
};

function affectedRows(result: { numAffectedRows?: bigint }): number {
  return Number(result.numAffectedRows ?? 0n);
}

export function pruneChannelIngressInDatabase(
  db: DatabaseSync,
  input: ChannelIngressPruneInput,
): number {
  const {
    queueName,
    pendingCutoff,
    completedCutoff,
    failedCutoff,
    pendingMaxEntries,
    completedMaxEntries,
    failedMaxEntries,
    protectIds,
  } = input;
  const kysely = getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);
  let deleted = 0;
  if (pendingCutoff !== null) {
    let deleteQuery = kysely
      .deleteFrom("channel_ingress_events")
      .where("queue_name", "=", queueName)
      .where("status", "=", "pending")
      .where("updated_at", "<", pendingCutoff);
    if (protectIds.length > 0) {
      deleteQuery = deleteQuery.where("event_id", "not in", protectIds);
    }
    deleted += affectedRows(executeSqliteQuerySync(db, deleteQuery));
  }
  if (completedCutoff !== null) {
    let deleteQuery = kysely
      .deleteFrom("channel_ingress_events")
      .where("queue_name", "=", queueName)
      .where("status", "=", "completed")
      .where("completed_at", "<", completedCutoff);
    if (protectIds.length > 0) {
      deleteQuery = deleteQuery.where("event_id", "not in", protectIds);
    }
    deleted += affectedRows(executeSqliteQuerySync(db, deleteQuery));
  }
  if (failedCutoff !== null) {
    let deleteQuery = kysely
      .deleteFrom("channel_ingress_events")
      .where("queue_name", "=", queueName)
      .where("status", "=", "failed")
      .where("failed_at", "<", failedCutoff);
    if (protectIds.length > 0) {
      deleteQuery = deleteQuery.where("event_id", "not in", protectIds);
    }
    deleted += affectedRows(executeSqliteQuerySync(db, deleteQuery));
  }
  const pruneMaxEntries = (status: string, maxEntries: number | null) => {
    if (maxEntries === null) {
      return;
    }
    const batchSize = 500;
    const protectedSet = new Set(protectIds);
    // Page before filtering protected IDs; they still occupy their retention slots.
    while (true) {
      const rowsToDelete = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("channel_ingress_events")
          .select("event_id")
          .where("queue_name", "=", queueName)
          .where("status", "=", status)
          .orderBy("updated_at", "desc")
          .orderBy("event_id", "desc")
          .limit(batchSize)
          .offset(maxEntries),
      ).rows;
      const ids = rowsToDelete.map((row) => row.event_id).filter((id) => !protectedSet.has(id));
      if (ids.length === 0) {
        return;
      }
      deleted += affectedRows(
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("channel_ingress_events")
            .where("queue_name", "=", queueName)
            .where("status", "=", status)
            .where("event_id", "in", ids),
        ),
      );
    }
  };
  pruneMaxEntries("pending", pendingMaxEntries);
  pruneMaxEntries("completed", completedMaxEntries);
  pruneMaxEntries("failed", failedMaxEntries);
  return deleted;
}
