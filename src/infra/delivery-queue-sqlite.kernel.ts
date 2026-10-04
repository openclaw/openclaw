// Connection-bound delivery queue operations shared by standalone and compound owners.
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import {
  bindDeliveryQueueEntry,
  deliveryQueueEntriesQuery,
  inflateDeliveryQueueRow,
  loadDeliveryQueueEntryInDatabase,
  pruneDeliveryQueueTombstoneAges,
  pruneDeliveryQueueTombstones,
  terminalizeBoundDeliveryQueueEntry,
  type DeliveryQueueDatabase,
  type DeliveryQueueReadMode,
  type UpsertDeliveryQueueEntryParams,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite-bound.js";
import {
  hasLiveDeliveryQueueClaim,
  inferDeliveryQueueFailureRetention,
  parseDeliveryQueueCompletionRetention,
  projectDeliveryQueueTerminalEntry,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

export type DeliveryQueueStoredStatus = DeliveryQueueDatabase["delivery_queue_entries"]["status"];

export type TerminalizePendingDeliveryQueueEntryResult =
  | { status: "terminalized"; retained: boolean }
  | { status: "not_pending" };

export function deliveryQueueEntryNotFoundError(
  queueName: string,
  id: string,
): Error & { code: string } {
  return Object.assign(new Error(`No pending ${queueName} delivery queue entry ${id}`), {
    code: "ENOENT",
  });
}

export function upsertDeliveryQueueEntryInDatabase(
  params: Omit<UpsertDeliveryQueueEntryParams, "stateDir">,
  database: OpenClawStateDatabase,
): boolean {
  return upsertBoundDeliveryQueueEntryInDatabase(bindDeliveryQueueEntry(params), database);
}

export function expireStagingAndLoadDeliveryQueueEntriesInDatabase(
  database: OpenClawStateDatabase,
  params: {
    expireBeforeMs: number;
    queueNames: readonly string[];
    stagingQueueName: string;
  },
): {
  entries: DeliveryQueueEntryState[];
  stagingEntries: DeliveryQueueEntryState[];
} {
  const snapshot = runSqliteImmediateTransactionSync(
    database.db,
    () => {
      executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<DeliveryQueueDatabase>(database.db)
          .deleteFrom("delivery_queue_entries")
          .where("queue_name", "=", params.stagingQueueName)
          .where("status", "=", "pending")
          .where("enqueued_at", "<=", params.expireBeforeMs),
      );
      const read = (queueNames: readonly string[]) =>
        executeSqliteQuerySync(
          database.db,
          deliveryQueueEntriesQuery(database, queueNames, "unfinished")
            .orderBy("enqueued_at", "asc")
            .orderBy("id", "asc"),
        ).rows;
      return {
        entryRows: read(params.queueNames),
        stagingRows: read([params.stagingQueueName]),
      };
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "expire delivery queue staging entries",
    },
  );
  return {
    entries: snapshot.entryRows
      .map(inflateDeliveryQueueRow)
      .filter((entry): entry is DeliveryQueueEntryState => entry != null),
    stagingEntries: snapshot.stagingRows
      .map(inflateDeliveryQueueRow)
      .filter((entry): entry is DeliveryQueueEntryState => entry != null),
  };
}

type DeliveryQueueOwner = { status: DeliveryQueueStoredStatus; settlementPending?: true };

/** Keeps namespace reads and receipt pruning on the caller's exact transaction handle. */
export function getDeliveryQueueEntryOwnersInDatabase(
  database: OpenClawStateDatabase,
  queueNames: readonly string[],
  id: string,
): Map<string, DeliveryQueueOwner> {
  return getDeliveryQueueEntriesOwnersInDatabase(database, queueNames, [id]).get(id) ?? new Map();
}

export function getDeliveryQueueEntriesOwnersInDatabase(
  database: OpenClawStateDatabase,
  queueNames: readonly string[],
  ids: readonly string[],
): Map<string, Map<string, DeliveryQueueOwner>> {
  if (queueNames.length === 0 || ids.length === 0) {
    return new Map();
  }
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const uniqueIds = [...new Set(ids)];
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const readExact = () => {
        const query = queueDb
          .selectFrom("delivery_queue_entries")
          .select(["id", "queue_name", "status", "recovery_state"])
          .select((eb) =>
            eb
              .case("recovery_state")
              .when("completed_bounded")
              .then(eb.ref("entry_json"))
              .else(null)
              .end()
              .as("entry_json"),
          )
          .where("queue_name", "in", queueNames);
        const readChunk = (chunk: string[]) => {
          const id = chunk.length === 1 ? chunk[0] : undefined;
          return executeSqliteQuerySync(
            database.db,
            id === undefined ? query.where("id", "in", chunk) : query.where("id", "=", id),
          ).rows;
        };
        // Bound parameter counts while retaining one transaction across the complete batch.
        const rows = readChunk(uniqueIds.slice(0, 500));
        for (let offset = 500; offset < uniqueIds.length; offset += 500) {
          rows.push(...readChunk(uniqueIds.slice(offset, offset + 500)));
        }
        return rows;
      };
      let rows = readExact();
      let pruned = false;
      const prunedPrefixes = new Map<string, Set<string>>();
      for (const row of rows) {
        if (row.entry_json === null) {
          continue;
        }
        const entry = safeParseJsonRecord(row.entry_json);
        const retention = parseDeliveryQueueCompletionRetention(entry?.completionRetention, row.id);
        if (typeof retention === "object") {
          const prefixes = prunedPrefixes.get(row.queue_name) ?? new Set<string>();
          if (prefixes.has(retention.idPrefix)) {
            continue;
          }
          prefixes.add(retention.idPrefix);
          prunedPrefixes.set(row.queue_name, prefixes);
          const changed = pruneDeliveryQueueTombstones(database.db, Date.now(), {
            queueName: row.queue_name,
            idPrefix: retention.idPrefix,
          });
          pruned = changed || pruned;
        }
      }
      if (pruned) {
        rows = readExact();
      }
      const owners = new Map<string, Map<string, DeliveryQueueOwner>>();
      for (const row of rows) {
        if (row.status) {
          const namespaces = owners.get(row.id) ?? new Map<string, DeliveryQueueOwner>();
          namespaces.set(row.queue_name, {
            status: row.status,
            ...(row.status === "failed" && row.recovery_state === "settlement_pending"
              ? { settlementPending: true as const }
              : {}),
          });
          owners.set(row.id, namespaces);
        }
      }
      return owners;
    },
    { databaseLabel: "openclaw-state", operationLabel: "read delivery queue status" },
  );
}

export function loadDeliveryQueueEntriesInDatabase(
  database: OpenClawStateDatabase,
  queueName: string,
  mode: DeliveryQueueReadMode = "pending",
): DeliveryQueueEntryState[] {
  const rows = executeSqliteQuerySync(
    database.db,
    deliveryQueueEntriesQuery(database, [queueName], mode)
      .orderBy("enqueued_at", "asc")
      .orderBy("id", "asc"),
  ).rows;
  return rows
    .map(inflateDeliveryQueueRow)
    .filter((entry): entry is DeliveryQueueEntryState => entry != null);
}

export function deleteDeliveryQueueEntryInDatabase(
  database: OpenClawStateDatabase,
  queueName: string,
  id: string,
): void {
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    queueDb
      .deleteFrom("delivery_queue_entries")
      .where("queue_name", "=", queueName)
      .where("id", "=", id)
      .where("status", "=", "pending"),
  );
}

export function completeDeliveryQueueEntryInDatabase(
  database: OpenClawStateDatabase,
  queueName: string,
  id: string,
): void {
  const now = Date.now();
  const current = loadDeliveryQueueEntryInDatabase(database, queueName, id, "pending");
  completeLoadedDeliveryQueueEntryInDatabase(database, queueName, id, current, now);
}

/** Shared completion policy; reuse a prior read only while its write transaction remains held. */
export function completeLoadedDeliveryQueueEntryInDatabase(
  database: OpenClawStateDatabase,
  queueName: string,
  id: string,
  current: DeliveryQueueEntryState | null,
  now = Date.now(),
): void {
  const requestedRetention = current?.completionRetention;
  const retention = parseDeliveryQueueCompletionRetention(requestedRetention, id);
  if (requestedRetention && !retention) {
    throw new Error(`Invalid bounded delivery completion retention: ${queueName}/${id}`);
  }
  const tombstone = projectDeliveryQueueTerminalEntry(
    { id, retryCount: 0 },
    now,
    "completed",
    retention,
  );
  const completed = upsertDeliveryQueueEntryInDatabase(
    {
      queueName,
      entry: tombstone,
      metadata: {},
      status: "completed",
      completeExisting: true,
    },
    database,
  );
  if (!completed) {
    if (
      getDeliveryQueueEntryOwnersInDatabase(database, [queueName], id).get(queueName)?.status ===
      "completed"
    ) {
      return;
    }
    throw deliveryQueueEntryNotFoundError(queueName, id);
  }
  if (typeof retention === "object") {
    getDeliveryQueueEntryOwnersInDatabase(database, [queueName], id);
  }
}

export function updateDeliveryQueueEntryInDatabase(
  database: OpenClawStateDatabase,
  queueName: string,
  id: string,
  update: (entry: DeliveryQueueEntryState) => DeliveryQueueEntryState,
): void {
  const current = loadDeliveryQueueEntryInDatabase(database, queueName, id, "pending");
  if (!current) {
    throw deliveryQueueEntryNotFoundError(queueName, id);
  }
  upsertDeliveryQueueEntryInDatabase({ queueName, entry: update(current) }, database);
}

export type ReserveDeliveryQueueAttemptResult =
  | { status: "reserved"; attemptCount: number }
  | { status: "exhausted"; attemptCount: number };

export function reserveDeliveryQueueEntryAttemptInDatabase(
  database: OpenClawStateDatabase,
  params: {
    queueName: string;
    id: string;
    maxAttempts: number;
    expectedPlatformSendAttemptId?: string;
  },
): ReserveDeliveryQueueAttemptResult {
  if (!Number.isInteger(params.maxAttempts) || params.maxAttempts <= 0) {
    throw new Error(`Invalid delivery attempt budget: ${params.maxAttempts}`);
  }
  const current = loadDeliveryQueueEntryInDatabase(
    database,
    params.queueName,
    params.id,
    "pending",
  );
  if (!current) {
    throw deliveryQueueEntryNotFoundError(params.queueName, params.id);
  }
  if (
    params.expectedPlatformSendAttemptId &&
    !hasLiveDeliveryQueueClaim(current, params.expectedPlatformSendAttemptId, Date.now())
  ) {
    throw new Error(`Delivery platform claim was lost: ${params.id}`);
  }
  const persistedAttemptCount =
    typeof current.attemptCount === "number" &&
    Number.isInteger(current.attemptCount) &&
    current.attemptCount >= 0
      ? current.attemptCount
      : 0;
  const attemptCount = Math.max(persistedAttemptCount, current.retryCount);
  if (attemptCount >= params.maxAttempts) {
    return { status: "exhausted", attemptCount };
  }
  const reservedAttemptCount = attemptCount + 1;
  const updated = upsertDeliveryQueueEntryInDatabase(
    {
      queueName: params.queueName,
      entry: { ...current, attemptCount: reservedAttemptCount },
      updatePendingOnly: true,
    },
    database,
  );
  if (!updated) {
    throw deliveryQueueEntryNotFoundError(params.queueName, params.id);
  }
  return { status: "reserved", attemptCount: reservedAttemptCount };
}

export function countFailedDeliveryQueueEntriesInDatabase(database: OpenClawStateDatabase): Array<{
  queueName: string;
  count: number;
  oldestFailedAt?: number;
}> {
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select((eb) => [
        "queue_name as queueName",
        eb.fn.countAll<number>().as("count"),
        eb.fn.min<number>("failed_at").as("oldestFailedAt"),
      ])
      .where("status", "=", "failed")
      .groupBy("queue_name")
      .orderBy("queue_name", "asc"),
  ).rows;
  return rows.map(({ oldestFailedAt, ...row }) =>
    oldestFailedAt == null ? row : Object.assign(row, { oldestFailedAt }),
  );
}

export function countPendingDeliveryQueueEntriesInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  queueNames: readonly string[],
): number {
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const [row] = executeSqliteQuerySync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("queue_name", "in", queueNames)
      .where("status", "=", "pending"),
  ).rows;
  return row?.count ?? 0;
}

export function pruneExpiredDeliveryQueueTombstonesInDatabase(
  database: OpenClawStateDatabase,
): void {
  runSqliteImmediateTransactionSync(
    database.db,
    () => pruneDeliveryQueueTombstoneAges(database.db, Date.now()),
    { databaseLabel: "openclaw-state", operationLabel: "expire delivery queue tombstones" },
  );
}

export type TerminalizePendingDeliveryQueueEntryParams = {
  queueName: string;
  id: string;
  entry: DeliveryQueueEntryState;
  expectedStatus?: "pending" | "failed";
};

/** Validate and serialize terminal custody before a standalone call opens its database. */
export function prepareDeliveryQueueTerminalEntry(
  params: TerminalizePendingDeliveryQueueEntryParams,
) {
  if (params.entry.id !== params.id) {
    throw new Error(`Delivery queue entry id mismatch: ${params.entry.id} != ${params.id}`);
  }
  const now = Date.now();
  const expectedJson = JSON.stringify(params.entry);
  const retention = inferDeliveryQueueFailureRetention(params.entry, params.id, params.queueName);
  const failedEntry = retention
    ? projectDeliveryQueueTerminalEntry(params.entry, now, "failed", retention)
    : undefined;
  return {
    queueName: params.queueName,
    id: params.id,
    expectedStatus: params.expectedStatus,
    now,
    expectedJson,
    retention,
    failedEntry,
  };
}

export function terminalizePendingDeliveryQueueEntryInDatabase(
  database: OpenClawStateDatabase,
  prepared: ReturnType<typeof prepareDeliveryQueueTerminalEntry>,
): TerminalizePendingDeliveryQueueEntryResult {
  const { queueName, id, expectedJson, failedEntry, now, expectedStatus, retention } = prepared;
  if (
    !terminalizeBoundDeliveryQueueEntry(
      database.db,
      queueName,
      id,
      expectedJson,
      failedEntry,
      now,
      expectedStatus,
    )
  ) {
    return { status: "not_pending" };
  }
  if (typeof retention === "object") {
    getDeliveryQueueEntryOwnersInDatabase(database, [queueName], id);
  }
  return { status: "terminalized", retained: retention !== undefined };
}
