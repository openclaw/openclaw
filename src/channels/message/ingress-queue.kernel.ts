import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { FAILED_NULL_PAYLOAD_SENTINEL } from "./ingress-queue.codec.js";
import type { ChannelIngressQueuePruneOptions } from "./ingress-queue.types.js";

const getQueue = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);
const affectedRows = (result: { numAffectedRows?: bigint }) => Number(result.numAffectedRows ?? 0n);

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

export function pruneChannelIngressInDatabase(
  db: DatabaseSync,
  input: {
    queueName: string;
    options: Omit<ChannelIngressQueuePruneOptions, "protectIds"> & { protectIds?: string[] };
    now: number;
  },
): number {
  const kysely = getQueue(db);
  const protectedIds = (input.options.protectIds ?? []).map((id) => id.trim()).filter(Boolean);
  const protectedSet = new Set(protectedIds);
  let deleted = 0;
  const policies = [
    {
      status: "pending",
      column: "updated_at",
      ttl: input.options.pendingTtlMs,
      max: input.options.pendingMaxEntries,
    },
    {
      status: "completed",
      column: "completed_at",
      ttl: input.options.completedTtlMs,
      max: input.options.completedMaxEntries,
    },
    {
      status: "failed",
      column: "failed_at",
      ttl: input.options.failedTtlMs,
      max: input.options.failedMaxEntries,
    },
  ] as const;
  for (const policy of policies) {
    if (policy.ttl !== undefined) {
      let query = kysely
        .deleteFrom("channel_ingress_events")
        .where("queue_name", "=", input.queueName)
        .where("status", "=", policy.status)
        .where(policy.column, "<", input.now - policy.ttl);
      if (protectedIds.length) {
        query = query.where("event_id", "not in", protectedIds);
      }
      deleted += affectedRows(executeSqliteQuerySync(db, query));
    }
    if (policy.max === undefined) {
      continue;
    }
    while (true) {
      // Protected rows occupy their original retention slots.
      const rows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("channel_ingress_events")
          .select("event_id")
          .where("queue_name", "=", input.queueName)
          .where("status", "=", policy.status)
          .orderBy("updated_at", "desc")
          .orderBy("event_id", "desc")
          .limit(500)
          .offset(Math.max(0, Math.floor(policy.max))),
      ).rows;
      const ids = rows.map((row) => row.event_id).filter((id) => !protectedSet.has(id));
      if (!ids.length) {
        break;
      }
      deleted += affectedRows(
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("channel_ingress_events")
            .where("queue_name", "=", input.queueName)
            .where("status", "=", policy.status)
            .where("event_id", "in", ids),
        ),
      );
    }
  }
  return deleted;
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
