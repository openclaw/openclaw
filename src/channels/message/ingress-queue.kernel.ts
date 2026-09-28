import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  baseRecord,
  CHANNEL_INGRESS_CORRUPT_REPAIR_LIMIT,
  claimedRecord,
  decodeClaimColumns,
  FAILED_NULL_PAYLOAD_SENTINEL,
  parseFailedPayload,
} from "./ingress-queue.codec.js";
import type {
  ChannelIngressClaimRequest,
  ChannelIngressClaimSelection,
  ChannelIngressClaimSnapshot,
  ChannelIngressListInput,
  ChannelIngressQueuePruneOptions,
  ChannelIngressRow,
  ChannelIngressScope,
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

export function readChannelIngressClaimSnapshotInDatabase(
  db: DatabaseSync,
  input: ChannelIngressClaimRequest,
): ChannelIngressClaimSnapshot {
  const base = getQueue(db)
    .selectFrom("channel_ingress_events")
    .selectAll()
    .where("queue_name", "=", input.queueName);
  const claimed = input.candidateIds?.length
    ? executeSqliteQuerySync(
        db,
        base
          .where("status", "=", "claimed")
          .where("event_id", "in", input.candidateIds)
          .orderBy("event_id", "asc"),
      ).rows
    : [];
  if (input.candidateIds?.length === 0) {
    return { pending: [], claimed };
  }
  let pending = base.where("status", "=", "pending");
  if (input.candidateIds) {
    pending = pending.where("event_id", "in", input.candidateIds);
  }
  const blocked = [
    ...new Set([
      ...input.blockedLaneKeys,
      ...claimed.flatMap((row) => (row.lane_key ? [row.lane_key] : [])),
    ]),
  ];
  if (!input.deriveLaneKey && blocked.length) {
    pending = pending.where((eb) =>
      eb.or([eb("lane_key", "is", null), eb("lane_key", "not in", blocked)]),
    );
  }
  const ordered =
    input.orderBy === "id"
      ? pending.orderBy("event_id", "asc")
      : pending.orderBy("received_at", "asc").orderBy("event_id", "asc");
  // Repair can expose up to 100 later rows without changing the caller's scan window.
  return {
    claimed,
    pending: executeSqliteQuerySync(
      db,
      ordered.limit(normalizeLimit(input.scanLimit) + CHANNEL_INGRESS_CORRUPT_REPAIR_LIMIT),
    ).rows,
  };
}

function tombstoneCorruptRow(
  db: DatabaseSync,
  row: ChannelIngressRow,
  now: number,
  reason: "corrupt_payload" | "corrupt_claim",
) {
  executeSqliteQuerySync(
    db,
    getQueue(db)
      .updateTable("channel_ingress_events")
      .set((eb) => ({
        status: "failed",
        failed_at: now,
        failed_reason: reason,
        last_error: null,
        ...(reason === "corrupt_payload"
          ? { payload_json: "null", metadata_json: null }
          : {
              payload_json: eb
                .case()
                .when("payload_json", "=", "null")
                .then(FAILED_NULL_PAYLOAD_SENTINEL)
                .else(eb.ref("payload_json"))
                .end(),
            }),
        claim_token: null,
        claim_owner: null,
        claimed_at: null,
        updated_at: now,
      }))
      .where("queue_name", "=", row.queue_name)
      .where("event_id", "=", row.event_id),
  );
}

export function enqueueChannelIngressInDatabase(
  db: DatabaseSync,
  input: ChannelIngressScope & {
    id: string;
    payloadJson: string;
    metadataJson: string | null;
    receivedAt: number;
    now: number;
    laneKey?: string;
  },
): { accepted: boolean; row: ChannelIngressRow } {
  const inserted = executeSqliteQuerySync(
    db,
    getQueue(db)
      .insertInto("channel_ingress_events")
      .values({
        queue_name: input.queueName,
        event_id: input.id,
        channel_id: input.channelId,
        account_id: input.accountId,
        status: "pending",
        lane_key: input.laneKey ?? null,
        payload_json: input.payloadJson,
        metadata_json: input.metadataJson,
        received_at: input.receivedAt,
        updated_at: input.now,
        attempts: 0,
      })
      .onConflict((conflict) => conflict.columns(["queue_name", "event_id"]).doNothing()),
  );
  let row = selectRow(db, input.queueName, input.id);
  if (!row) {
    throw new Error(`Failed to read channel ingress event ${input.queueName}/${input.id}`);
  }
  const accepted = affectedRows(inserted) > 0;
  if (accepted && !baseRecord(row)) {
    throw new Error(`Corrupt payload_json in channel ingress event ${input.queueName}/${input.id}`);
  }
  if (row.status === "claimed" && !claimedRecord(row)) {
    throw new Error(`Corrupt claimed channel ingress event ${input.queueName}/${input.id}`);
  }
  if (row.status === "pending" && !baseRecord(row)) {
    tombstoneCorruptRow(db, row, input.now, "corrupt_payload");
    row = selectRow(db, input.queueName, input.id);
    if (!row) {
      throw new Error(`Failed to read corrupt ingress tombstone ${input.queueName}/${input.id}`);
    }
  }
  return { accepted, row };
}

export function claimChannelIngressInDatabase(
  db: DatabaseSync,
  input: { queueName: string; id: string; ownerId: string; laneKey?: string },
  now: () => number = Date.now,
): ChannelIngressRow | null {
  // Start the lease after worker admission, not while waiting for the writer.
  const transitionAt = now();
  const row = selectRow(db, input.queueName, input.id);
  if (!row || row.status !== "pending") {
    return null;
  }
  if (!baseRecord(row)) {
    tombstoneCorruptRow(db, row, transitionAt, "corrupt_payload");
    return null;
  }
  executeSqliteQuerySync(
    db,
    getQueue(db)
      .updateTable("channel_ingress_events")
      .set({
        status: "claimed",
        claim_token: randomUUID(),
        claim_owner: input.ownerId,
        claimed_at: transitionAt,
        updated_at: transitionAt,
        ...(input.laneKey ? { lane_key: input.laneKey } : {}),
      })
      .where("queue_name", "=", input.queueName)
      .where("event_id", "=", input.id)
      .where("status", "=", "pending"),
  );
  return selectRow(db, input.queueName, input.id) ?? null;
}

export function claimNextChannelIngressInDatabase(
  db: DatabaseSync,
  input: {
    request: ChannelIngressClaimRequest;
    snapshot: ChannelIngressClaimSnapshot;
    selection: ChannelIngressClaimSelection;
    ownerId: string;
  },
  now: () => number = Date.now,
): { kind: "conflict" } | { kind: "claimed"; row: ChannelIngressRow | null } {
  const current = readChannelIngressClaimSnapshotInDatabase(db, input.request);
  // Recheck the full ordered window, including claimed siblings, before using host policy.
  if (JSON.stringify(current) !== JSON.stringify(input.snapshot)) {
    return { kind: "conflict" };
  }
  const transitionAt = now();
  const corrupt = new Set(input.selection.corruptIds);
  for (const row of current.pending) {
    if (corrupt.has(row.event_id)) {
      tombstoneCorruptRow(db, row, transitionAt, "corrupt_payload");
    }
  }
  const selected = input.selection.selected;
  return {
    kind: "claimed",
    row: selected
      ? claimChannelIngressInDatabase(
          db,
          { queueName: input.request.queueName, ...selected, ownerId: input.ownerId },
          () => transitionAt,
        )
      : null,
  };
}

export function recoverChannelIngressClaimInDatabase(
  db: DatabaseSync,
  input: { row: ChannelIngressRow; cutoff: number; now: number },
): boolean {
  const current = selectRow(db, input.row.queue_name, input.row.event_id);
  if (!current || JSON.stringify(current) !== JSON.stringify(input.row)) {
    return false;
  }
  const claim = decodeClaimColumns(current);
  if (!claim || !claimedRecord(current)) {
    tombstoneCorruptRow(db, current, input.now, claim ? "corrupt_payload" : "corrupt_claim");
    return true;
  }
  return (
    affectedRows(
      executeSqliteQuerySync(
        db,
        getQueue(db)
          .updateTable("channel_ingress_events")
          .set((eb) => ({
            status: "pending",
            claim_token: null,
            claim_owner: null,
            claimed_at: null,
            attempts: eb("attempts", "+", 1),
            last_attempt_at: input.now,
            updated_at: input.now,
          }))
          .where("queue_name", "=", current.queue_name)
          .where("event_id", "=", current.event_id)
          .where("status", "=", "claimed")
          .where("claim_token", "=", claim.token)
          .where("claimed_at", "<=", input.cutoff),
      ),
    ) > 0
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

export function completeChannelIngressInDatabase(
  db: DatabaseSync,
  input: ChannelIngressMutation & ChannelIngressScope & { metadataJson: string | null },
): boolean {
  const update = executeSqliteQuerySync(
    db,
    selectedMutation(db, input).set({
      status: "completed",
      completed_at: input.now,
      completed_metadata_json: input.metadataJson,
      payload_json: "null",
      metadata_json: null,
      claim_token: null,
      claim_owner: null,
      claimed_at: null,
      last_attempt_at: null,
      last_error: null,
      updated_at: input.now,
    }),
  );
  if (affectedRows(update) > 0) {
    return true;
  }
  if (input.token !== null) {
    return false;
  }
  return (
    affectedRows(
      executeSqliteQuerySync(
        db,
        getQueue(db)
          .insertInto("channel_ingress_events")
          .values({
            queue_name: input.queueName,
            event_id: input.id,
            channel_id: input.channelId,
            account_id: input.accountId,
            status: "completed",
            lane_key: null,
            payload_json: "null",
            metadata_json: null,
            received_at: input.now,
            updated_at: input.now,
            attempts: 0,
            completed_at: input.now,
            completed_metadata_json: input.metadataJson,
          })
          .onConflict((conflict) => conflict.columns(["queue_name", "event_id"]).doNothing()),
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
  // Native text rows cannot match an unpaired surrogate through JS string equality.
  const protectedMaxIds = protectedIds.filter((id) => id.isWellFormed());
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
    // Protected rows occupy their original retention slots.
    const candidates = kysely
      .selectFrom("channel_ingress_events")
      .select("event_id")
      .where("queue_name", "=", input.queueName)
      .where("status", "=", policy.status)
      .orderBy("updated_at", "desc")
      .orderBy("event_id", "desc")
      .limit(500)
      .offset(Math.max(0, Math.floor(policy.max)));
    let query = kysely
      .deleteFrom("channel_ingress_events")
      .where("queue_name", "=", input.queueName)
      .where("status", "=", policy.status)
      .where("event_id", "in", candidates);
    if (protectedMaxIds.length) {
      query = query.where("event_id", "not in", sqliteStringSet(protectedMaxIds));
    }
    while (true) {
      const removed = affectedRows(executeSqliteQuerySync(db, query));
      if (!removed) {
        break;
      }
      deleted += removed;
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

export function deleteChannelIngressInDatabase(
  db: DatabaseSync,
  input: ChannelIngressMutation,
): boolean {
  const base = getQueue(db)
    .deleteFrom("channel_ingress_events")
    .where("queue_name", "=", input.queueName)
    .where("event_id", "=", input.id);
  return (
    affectedRows(
      executeSqliteQuerySync(
        db,
        input.token === null
          ? base.where("status", "=", "pending")
          : base.where("status", "=", "claimed").where("claim_token", "=", input.token),
      ),
    ) > 0
  );
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
    .where("status", "in", input.status === "unsettled" ? ["pending", "claimed"] : [input.status]);
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
  if (input.status === "unsettled") {
    return executeSqliteQuerySync(db, ordered).rows;
  }
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
