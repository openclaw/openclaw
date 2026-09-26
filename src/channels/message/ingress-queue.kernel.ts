import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  baseRecord,
  FAILED_NULL_PAYLOAD_SENTINEL,
  parseFailedPayload,
} from "./ingress-queue.codec.js";
import type {
  ChannelIngressListInput,
  ChannelIngressQueuePruneOptions,
  ChannelIngressRow,
} from "./ingress-queue.types.js";

const getQueue = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);
const affectedRows = (result: { numAffectedRows?: bigint }) => Number(result.numAffectedRows ?? 0n);

// Materialize pending rows in bounded chunks because SQLite's json_valid()
// rejects some payloads accepted by the queue's JSON.stringify/JSON.parse contract.
const LIST_PENDING_BATCH_SIZE = 100;

function normalizeLimit(limit: number | "all" | undefined): number {
  return limit === "all" ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.floor(limit ?? 100));
}

function selectRow(db: DatabaseSync, queueName: string, id: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getQueue(db)
      .selectFrom("channel_ingress_events")
      .selectAll()
      .where("queue_name", "=", queueName)
      .where("event_id", "=", id),
  );
}

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

export function listStaleChannelIngressClaimsInDatabase(
  db: DatabaseSync,
  input: { queueName: string; cutoff: number },
): ChannelIngressRow[] {
  return executeSqliteQuerySync(
    db,
    getQueue(db)
      .selectFrom("channel_ingress_events")
      .selectAll()
      .where("queue_name", "=", input.queueName)
      .where("status", "=", "claimed")
      .where((eb) =>
        eb.or([
          eb("claimed_at", "<=", input.cutoff),
          eb("claimed_at", "is", null),
          eb("claim_token", "is", null),
          eb("claim_owner", "is", null),
          eb("claim_token", "=", ""),
          eb("claim_owner", "=", ""),
        ]),
      ),
  ).rows;
}

export function resubmitChannelIngressInDatabase(
  db: DatabaseSync,
  input: { queueName: string; id: string; now: number },
):
  | { kind: "not-found" }
  | { kind: "completed" | "unrecoverable"; row: ChannelIngressRow }
  | { kind: "active"; status: "pending" | "claimed" }
  | { kind: "resubmitted"; row: ChannelIngressRow; previous: ChannelIngressRow } {
  const row = selectRow(db, input.queueName, input.id);
  if (!row) {
    return { kind: "not-found" };
  }
  if (row.status === "completed") {
    return { kind: "completed", row };
  }
  if (row.status !== "failed") {
    return { kind: "active", status: row.status === "claimed" ? "claimed" : "pending" };
  }
  if (row.payload_json === "null" || !parseFailedPayload(row.payload_json).ok) {
    return { kind: "unrecoverable", row };
  }
  executeSqliteQuerySync(
    db,
    getQueue(db)
      .updateTable("channel_ingress_events")
      .set({
        status: "pending",
        payload_json: row.payload_json === FAILED_NULL_PAYLOAD_SENTINEL ? "null" : row.payload_json,
        received_at: input.now,
        updated_at: input.now,
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        failed_at: null,
        failed_reason: null,
        claim_token: null,
        claim_owner: null,
        claimed_at: null,
        completed_at: null,
        completed_metadata_json: null,
      })
      .where("queue_name", "=", input.queueName)
      .where("event_id", "=", input.id)
      .where("status", "=", "failed"),
  );
  const updated = selectRow(db, input.queueName, input.id);
  if (!updated) {
    throw new Error(
      `Failed to read resubmitted channel ingress event ${input.queueName}/${input.id}`,
    );
  }
  return { kind: "resubmitted", row: updated, previous: row };
}

export function purgeChannelIngressInDatabase(
  db: DatabaseSync,
  input: { queueName: string },
): number {
  return affectedRows(
    executeSqliteQuerySync(
      db,
      getQueue(db).deleteFrom("channel_ingress_events").where("queue_name", "=", input.queueName),
    ),
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

export function listChannelIngressRowsInDatabase(
  db: DatabaseSync,
  input: ChannelIngressListInput,
): ChannelIngressRow[] {
  const select = getQueue(db)
    .selectFrom("channel_ingress_events")
    .selectAll()
    .where("queue_name", "=", input.queueName)
    .where("status", "=", input.status);
  if (input.status === "claimed") {
    return executeSqliteQuerySync(
      db,
      select.orderBy("claimed_at", "asc").orderBy("received_at", "asc").orderBy("event_id", "asc"),
    ).rows;
  }
  if (input.status === "failed") {
    return executeSqliteQuerySync(
      db,
      select
        .orderBy("failed_at", "asc")
        .orderBy("event_id", "asc")
        .limit(normalizeLimit(input.limit)),
    ).rows;
  }
  const ordered =
    input.orderBy === "id"
      ? select.orderBy("event_id", "asc")
      : select.orderBy("received_at", "asc").orderBy("event_id", "asc");
  const limit = normalizeLimit(input.limit);
  const result: ChannelIngressRow[] = [];
  let last: ChannelIngressRow | undefined;
  while (result.length < limit) {
    let page = ordered;
    if (last) {
      const cursor = last;
      page =
        input.orderBy === "id"
          ? page.where("event_id", ">", cursor.event_id)
          : page.where((eb) =>
              eb.or([
                eb("received_at", ">", cursor.received_at),
                eb.and([
                  eb("received_at", "=", cursor.received_at),
                  eb("event_id", ">", cursor.event_id),
                ]),
              ]),
            );
    }
    const rows = executeSqliteQuerySync(db, page.limit(LIST_PENDING_BATCH_SIZE)).rows;
    for (const row of rows) {
      if (baseRecord(row)) {
        result.push(row);
        if (result.length === limit) {
          break;
        }
      }
    }
    if (rows.length < LIST_PENDING_BATCH_SIZE) {
      break;
    }
    last = rows.at(-1);
  }
  return result;
}
