/**
 * Durable channel ingress queue.
 *
 * Stores, claims, completes, and tombstones inbound channel events in OpenClaw state.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { resolveChannelIngressStateEnv } from "./ingress-queue-client.js";
import {
  FAILED_NULL_PAYLOAD_SENTINEL,
  parseFailedPayload,
  baseRecord,
  decodeClaimColumns,
  claimedRecord,
  corruptClaimRecord,
  completedRecord,
} from "./ingress-queue.codec.js";
import {
  failChannelIngressInDatabase,
  refreshChannelIngressClaimInDatabase,
  releaseChannelIngressInDatabase,
} from "./ingress-queue.kernel.js";
import type {
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueCompletedRecord,
  ChannelIngressQueueCorruptClaim,
  ChannelIngressQueuePruneOptions,
  ChannelIngressQueueRecord,
  ChannelIngressRow,
} from "./ingress-queue.types.js";

export type {
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueCorruptClaim,
  ChannelIngressQueuePruneOptions,
  ChannelIngressQueueRecord,
} from "./ingress-queue.types.js";

/** Failed ingress event tombstone retained for duplicate detection. */
type ChannelIngressQueueFailedRecord = {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  failedAt: number;
  reason: string;
  message?: string;
};

/** Rich failed ingress event retained for diagnostics and operator recovery. */
type ChannelIngressQueueDeadLetterRecord<
  TPayload = unknown,
  TMetadata = unknown,
> = ChannelIngressQueueFailedRecord & {
  payload?: TPayload;
  metadata?: TMetadata;
  receivedAt: number;
  updatedAt: number;
  laneKey?: string;
  attempts: number;
  lastAttemptAt?: number;
};

/** Outcome of asking a channel/account queue to re-enqueue one failed event. */
type ChannelIngressQueueResubmitResult<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
> =
  | {
      kind: "resubmitted";
      record: ChannelIngressQueueRecord<TPayload, TMetadata>;
      previous: ChannelIngressQueueDeadLetterRecord<TPayload, TMetadata>;
    }
  | { kind: "not-found" }
  | {
      kind: "completed";
      record: ChannelIngressQueueCompletedRecord<TCompletedMetadata>;
    }
  | { kind: "active"; status: "pending" | "claimed" }
  | {
      kind: "unrecoverable";
      record: ChannelIngressQueueDeadLetterRecord<TPayload, TMetadata>;
    };

/** Result of enqueueing a possibly duplicate ingress event id. */
type ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata> =
  | {
      kind: "accepted";
      duplicate: false;
      record: ChannelIngressQueueRecord<TPayload, TMetadata>;
    }
  | {
      kind: "pending";
      duplicate: true;
      record: ChannelIngressQueueRecord<TPayload, TMetadata>;
    }
  | {
      kind: "claimed";
      duplicate: true;
      record: ChannelIngressQueueClaim<TPayload, TMetadata>;
    }
  | {
      kind: "completed";
      duplicate: true;
      record: ChannelIngressQueueCompletedRecord<TCompletedMetadata>;
    }
  | {
      kind: "failed";
      duplicate: true;
      record: ChannelIngressQueueFailedRecord;
    };

/** Durable FIFO-ish ingress queue with claims, duplicate detection, and retention pruning. */
export type ChannelIngressQueue<TPayload, TMetadata = unknown, TCompletedMetadata = unknown> = {
  enqueue(
    id: string,
    payload: TPayload,
    options?: {
      metadata?: TMetadata;
      receivedAt?: number;
      laneKey?: string;
    },
  ): Promise<ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata>>;
  listPending(options?: {
    limit?: number | "all";
    orderBy?: "received" | "id";
  }): Promise<Array<ChannelIngressQueueRecord<TPayload, TMetadata>>>;
  listClaims(): Promise<Array<ChannelIngressQueueClaim<TPayload, TMetadata>>>;
  /** Additive SDK seam; optional so existing external queue test doubles remain compatible. */
  listFailed?(options?: {
    limit?: number | "all";
  }): Promise<Array<ChannelIngressQueueDeadLetterRecord<TPayload, TMetadata>>>;
  claimNext(options?: {
    ownerId?: string;
    blockedLaneKeys?: Iterable<string>;
    staleMs?: number;
    orderBy?: "received" | "id";
    scanLimit?: number;
    candidateIds?: Iterable<string>;
    deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined;
    /** Authorize a changed durable lane before the atomic pending-to-claimed transition. */
    reconcileStoredLaneKey?: (
      record: ChannelIngressQueueRecord<TPayload, TMetadata>,
      storedLaneKey: string,
      derivedLaneKey: string,
    ) => boolean;
  }): Promise<ChannelIngressQueueClaim<TPayload, TMetadata> | null>;
  claim(
    id: string,
    options?: { ownerId?: string },
  ): Promise<ChannelIngressQueueClaim<TPayload, TMetadata> | null>;
  refreshClaim?(
    claim: ChannelIngressQueueClaimRef,
    options?: { refreshedAt?: number },
  ): Promise<boolean>;
  complete(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options?: { metadata?: TCompletedMetadata; completedAt?: number },
  ): Promise<boolean>;
  release(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options?: { lastError?: string; releasedAt?: number; recordAttempt?: boolean },
  ): Promise<boolean>;
  fail(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options: { reason: string; message?: string; failedAt?: number },
  ): Promise<boolean>;
  /** Additive SDK seam; actual runtime queues support operator resubmission. */
  resubmit?(
    id: string,
    options?: { resubmittedAt?: number },
  ): Promise<ChannelIngressQueueResubmitResult<TPayload, TMetadata, TCompletedMetadata>>;
  delete(
    idOrClaim:
      | string
      | ChannelIngressQueueRecord<TPayload, TMetadata>
      | ChannelIngressQueueClaimRef,
  ): Promise<boolean>;
  recoverStaleClaims(options?: {
    staleMs?: number;
    now?: number;
    shouldRecover?: (
      claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    ) => boolean | Promise<boolean>;
    shouldRecoverCorrupt?: (claim: ChannelIngressQueueCorruptClaim) => boolean | Promise<boolean>;
  }): Promise<number>;
  prune(options?: ChannelIngressQueuePruneOptions): Promise<number>;
  /**
   * Delete all rows after callers stop the account's producers and drain.
   * Optional for existing plugin-supplied queue inputs; core queues implement it.
   */
  purge?(): Promise<number>;
};

/** Construction options for a channel/account-scoped ingress queue. */
export type CreateChannelIngressQueueOptions = {
  channelId: string;
  accountId?: string;
  stateDir?: string;
  now?: () => number;
  /**
   * `read-only` reads through the existing-database read-only opener, which never
   * creates, migrates, chmods or configures the shared state file. Callers that must
   * not touch durable state before they own it - Doctor detection runs before the
   * exclusive maintenance lock - use it so listing cannot take a write path.
   */
  access?: "read-write" | "read-only";
};

type ChannelIngressDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

function normalizePart(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

// Keep inherited lookups for HOME/etc. without enumerating large Kubernetes service envs.
function createStateDirEnv(
  stateDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = Object.create(baseEnv) as NodeJS.ProcessEnv;
  env.OPENCLAW_STATE_DIR = stateDir;
  return env;
}

function openChannelIngressDatabase(stateDir?: string) {
  return openOpenClawStateDatabase({
    env: stateDir ? createStateDirEnv(stateDir) : process.env,
  });
}

type ChannelIngressReadHandle = {
  db: DatabaseSync;
  release: () => void;
};

/**
 * Resolve a database handle for listing. Read-only callers get the non-creating opener
 * and own closing it; read-write callers keep the shared cached handle they already had.
 */
async function openChannelIngressDatabaseForListing(
  stateDir: string | undefined,
  access: "read-write" | "read-only",
): Promise<ChannelIngressReadHandle | undefined> {
  if (access !== "read-only") {
    return { db: openChannelIngressDatabase(stateDir).db, release: () => {} };
  }
  const env = stateDir ? createStateDirEnv(stateDir) : process.env;
  const database = await openExistingOpenClawStateDatabaseReadOnly({ env });
  if (!database) {
    return undefined;
  }
  return {
    db: database.db,
    release: () => {
      database.walMaintenance.close();
    },
  };
}

function getChannelIngressKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<ChannelIngressDatabase>(db);
}

function affectedRows(result: { numAffectedRows?: bigint }): number {
  return Number(result.numAffectedRows ?? 0n);
}

type ParseJsonResult = { ok: true; value: unknown } | { ok: false };

function parseJson(value: string): ParseJsonResult {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function failedRecord<TPayload, TMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueDeadLetterRecord<TPayload, TMetadata> {
  const payloadResult = parseFailedPayload(row.payload_json);
  const metadataResult = row.metadata_json === null ? null : parseJson(row.metadata_json);
  return {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    ...(payloadResult.ok && row.payload_json !== "null"
      ? { payload: payloadResult.value as TPayload }
      : {}),
    ...(metadataResult?.ok ? { metadata: metadataResult.value as TMetadata } : {}),
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    ...(row.lane_key === null ? {} : { laneKey: row.lane_key }),
    attempts: row.attempts,
    ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
    failedAt: row.failed_at ?? row.updated_at,
    reason: row.failed_reason ?? "failed",
    ...(row.last_error === null ? {} : { message: row.last_error }),
  };
}

function selectRow(db: DatabaseSync, queueName: string, id: string) {
  const kysely = getChannelIngressKysely(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("channel_ingress_events")
      .selectAll()
      .where("queue_name", "=", queueName)
      .where("event_id", "=", id),
  );
}

function tombstoneCorruptRow(params: {
  db: DatabaseSync;
  row: ChannelIngressRow;
  expectedStatus: "pending" | "claimed";
  failedAt: number;
  staleCutoff?: number;
  reason: "corrupt_payload" | "corrupt_claim";
}): boolean {
  const kysely = getChannelIngressKysely(params.db);
  const baseUpdate = kysely
    .updateTable("channel_ingress_events")
    .set((eb) => ({
      status: "failed",
      failed_at: params.failedAt,
      failed_reason: params.reason,
      last_error: null,
      // A corrupt payload is unreadable — scrub it. A corrupt claim can wrap a
      // valid payload; keep it resubmittable (JSON null maps to the fail() sentinel).
      ...(params.reason === "corrupt_payload"
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
      updated_at: params.failedAt,
    }))
    .where("queue_name", "=", params.row.queue_name)
    .where("event_id", "=", params.row.event_id)
    .where("status", "=", params.expectedStatus);
  if (params.expectedStatus === "pending") {
    return affectedRows(executeSqliteQuerySync(params.db, baseUpdate)) > 0;
  }
  // The exact-token guard fences concurrent re-claims: claiming always writes a
  // fresh random token, so a matching (or still-NULL) token proves the row is
  // unchanged since it was read. Malformed-claim tombstones rely on this guard
  // alone and pass no staleCutoff — their claimed_at can be NULL or corrupt.
  const claimGuardedUpdate =
    params.row.claim_token === null
      ? baseUpdate.where("claim_token", "is", null)
      : baseUpdate.where("claim_token", "=", params.row.claim_token);
  const staleGuardedUpdate =
    params.staleCutoff === undefined
      ? claimGuardedUpdate
      : claimGuardedUpdate.where("claimed_at", "<=", params.staleCutoff);
  return affectedRows(executeSqliteQuerySync(params.db, staleGuardedUpdate)) > 0;
}

function idFrom(idOrRecord: string | { id: string }): string {
  const id = normalizePart(typeof idOrRecord === "string" ? idOrRecord : idOrRecord.id, "");
  if (!id) {
    throw new Error("Channel ingress event id cannot be empty");
  }
  return id;
}

function claimTokenFrom(
  idOrClaim: string | { id: string; claim?: { token: string } },
): string | null {
  return typeof idOrClaim === "string" ? null : (idOrClaim.claim?.token ?? null);
}

function rowToEnqueueResult<TPayload, TMetadata, TCompletedMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata> | null {
  if (row.status === "completed") {
    return { kind: "completed", duplicate: true, record: completedRecord(row) };
  }
  if (row.status === "failed") {
    return {
      kind: "failed",
      duplicate: true,
      record: failedRecord<TPayload, TMetadata>(row),
    };
  }
  if (row.status === "claimed") {
    const rec = claimedRecord<TPayload, TMetadata>(row);
    return rec ? { kind: "claimed", duplicate: true, record: rec } : null;
  }
  const rec = baseRecord<TPayload, TMetadata>(row);
  return rec ? { kind: "pending", duplicate: true, record: rec } : null;
}

function normalizeLimit(limit: number | "all" | undefined): number {
  return limit === "all" ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.floor(limit ?? 100));
}

function normalizeScanLimit(limit: number | undefined): number {
  return Math.max(1, Math.floor(limit ?? 100));
}

// Materialize pending rows in bounded chunks because SQLite's json_valid()
// rejects some payloads accepted by the queue's JSON.stringify/JSON.parse contract.
const LIST_PENDING_BATCH_SIZE = 100;
// Keep repair work bounded under one SQLite write lock; later calls continue
// from the durable failed tombstones left by this call.
const MAX_CORRUPT_RECONCILIATIONS_PER_CLAIM = 100;

function normalizeMaxEntries(value: number | undefined): number | null {
  return value === undefined ? null : Math.max(0, Math.floor(value));
}

function normalizedProtectedIds(ids: Iterable<string> | undefined): string[] {
  return [...(ids ?? [])].map((id) => id.trim()).filter(Boolean);
}

function normalizedCandidateIds(ids: Iterable<string> | undefined): string[] | undefined {
  return ids === undefined ? undefined : [...ids].map((id) => id.trim()).filter(Boolean);
}

function queueNameForParts(channelId: string, accountId: string): string {
  // JSON tuple encoding keeps channel/account scopes unambiguous even when ids contain separators.
  return JSON.stringify([channelId, accountId]);
}

/** Account discovery never creates or migrates a missing database. */
export async function listChannelIngressQueueAccountIdsReadOnly(params: {
  channelId: string;
  stateDir?: string;
}): Promise<string[]> {
  const reply = await executeExistingOpenClawStateRead(
    { env: resolveChannelIngressStateEnv(params.stateDir) },
    {
      type: "channelIngress.accounts",
      input: { channelId: normalizePart(params.channelId, "unknown") },
    },
  );
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "channelIngress.accounts") {
    throw new Error("Channel ingress account reader returned an unexpected result");
  }
  return reply.result;
}

/** Creates a durable channel/account-scoped ingress queue backed by the OpenClaw state database. */
export function createChannelIngressQueue<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(
  options: CreateChannelIngressQueueOptions,
  assertPruneCurrent?: () => void,
): ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata> {
  const channelId = normalizePart(options.channelId, "unknown");
  const accountId = normalizePart(options.accountId, "default");
  const queueName = queueNameForParts(channelId, accountId);
  const now = options.now ?? Date.now;
  const access = options.access ?? "read-write";

  const enqueue: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["enqueue"] = async (
    id,
    payload,
    enqueueOptions,
  ) => {
    const eventId = normalizePart(id, "");
    if (!eventId) {
      throw new Error("Channel ingress event id cannot be empty");
    }
    const receivedAt = enqueueOptions?.receivedAt ?? now();
    const updatedAt = now();
    const database = openChannelIngressDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const insert = executeSqliteQuerySync(
          tx.db,
          kysely
            .insertInto("channel_ingress_events")
            .values({
              queue_name: queueName,
              event_id: eventId,
              channel_id: channelId,
              account_id: accountId,
              status: "pending",
              lane_key: enqueueOptions?.laneKey ?? null,
              payload_json: JSON.stringify(payload),
              metadata_json:
                enqueueOptions?.metadata === undefined
                  ? null
                  : JSON.stringify(enqueueOptions.metadata),
              received_at: receivedAt,
              updated_at: updatedAt,
              attempts: 0,
            })
            .onConflict((conflict) => conflict.columns(["queue_name", "event_id"]).doNothing()),
        );
        const row = selectRow(tx.db, queueName, eventId);
        if (!row) {
          throw new Error(`Failed to read channel ingress event ${queueName}/${eventId}`);
        }
        if (affectedRows(insert) > 0) {
          const fresh = baseRecord<TPayload, TMetadata>(row);
          if (fresh === null) {
            throw new Error(
              `Corrupt payload_json in channel ingress event ${queueName}/${eventId}`,
            );
          }
          return {
            kind: "accepted",
            duplicate: false,
            record: fresh,
          };
        }
        const dup = rowToEnqueueResult<TPayload, TMetadata, TCompletedMetadata>(row);
        if (dup === null) {
          // A live claimant may already be producing external side effects.
          // Duplicate enqueue cannot prove ownership is stale, so leave claimed
          // corruption for the ownership-aware recovery path.
          if (row.status === "claimed") {
            throw new Error(`Corrupt claimed channel ingress event ${queueName}/${eventId}`);
          }
          if (
            !tombstoneCorruptRow({
              db: tx.db,
              row,
              expectedStatus: "pending",
              failedAt: updatedAt,
              reason: "corrupt_payload",
            })
          ) {
            throw new Error(`Failed to tombstone corrupt ingress event ${queueName}/${eventId}`);
          }
          const failedRow = selectRow(tx.db, queueName, eventId);
          if (!failedRow) {
            throw new Error(`Failed to read corrupt ingress tombstone ${queueName}/${eventId}`);
          }
          return {
            kind: "failed",
            duplicate: true,
            record: failedRecord<TPayload, TMetadata>(failedRow),
          };
        }
        return dup;
      },
      { path: database.path },
    );
  };

  const listPending: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["listPending"] = async (listOptions) => {
    const handle = await openChannelIngressDatabaseForListing(options.stateDir, access);
    if (!handle) {
      return [];
    }
    const { db } = handle;
    try {
      const kysely = getChannelIngressKysely(db);
      const limit = normalizeLimit(listOptions?.limit);
      const records: Array<ChannelIngressQueueRecord<TPayload, TMetadata>> = [];
      let lastRow: ChannelIngressRow | undefined;
      while (records.length < limit) {
        let pageQuery = kysely
          .selectFrom("channel_ingress_events")
          .selectAll()
          .where("queue_name", "=", queueName)
          .where("status", "=", "pending");
        if (lastRow) {
          const cursor = lastRow;
          pageQuery =
            listOptions?.orderBy === "id"
              ? pageQuery.where("event_id", ">", cursor.event_id)
              : pageQuery.where((eb) =>
                  eb.or([
                    eb("received_at", ">", cursor.received_at),
                    eb.and([
                      eb("received_at", "=", cursor.received_at),
                      eb("event_id", ">", cursor.event_id),
                    ]),
                  ]),
                );
        }
        const orderedQuery =
          listOptions?.orderBy === "id"
            ? pageQuery.orderBy("event_id", "asc")
            : pageQuery.orderBy("received_at", "asc").orderBy("event_id", "asc");
        const rows = executeSqliteQuerySync(db, orderedQuery.limit(LIST_PENDING_BATCH_SIZE)).rows;
        for (const row of rows) {
          const record = baseRecord<TPayload, TMetadata>(row);
          if (record) {
            records.push(record);
            if (records.length === limit) {
              break;
            }
          }
        }
        if (rows.length < LIST_PENDING_BATCH_SIZE) {
          break;
        }
        lastRow = rows.at(-1);
      }
      return records;
    } finally {
      handle.release();
    }
  };

  const listClaims: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["listClaims"] = async () => {
    const handle = await openChannelIngressDatabaseForListing(options.stateDir, access);
    if (!handle) {
      return [];
    }
    const { db } = handle;
    try {
      const kysely = getChannelIngressKysely(db);
      const rows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("channel_ingress_events")
          .selectAll()
          .where("queue_name", "=", queueName)
          .where("status", "=", "claimed")
          .orderBy("claimed_at", "asc")
          .orderBy("received_at", "asc")
          .orderBy("event_id", "asc"),
      ).rows;
      return rows
        .map((row) => claimedRecord<TPayload, TMetadata>(row))
        .filter((rec): rec is ChannelIngressQueueClaim<TPayload, TMetadata> => rec !== null);
    } finally {
      handle.release();
    }
  };

  const listFailed: NonNullable<
    ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["listFailed"]
  > = async (listOptions) => {
    const handle = await openChannelIngressDatabaseForListing(options.stateDir, access);
    if (!handle) {
      return [];
    }
    const { db } = handle;
    try {
      const rows = executeSqliteQuerySync(
        db,
        getChannelIngressKysely(db)
          .selectFrom("channel_ingress_events")
          .selectAll()
          .where("queue_name", "=", queueName)
          .where("status", "=", "failed")
          .orderBy("failed_at", "asc")
          .orderBy("event_id", "asc")
          .limit(normalizeLimit(listOptions?.limit)),
      ).rows;
      return rows.map((row) => failedRecord<TPayload, TMetadata>(row));
    } finally {
      handle.release();
    }
  };

  const claimNext: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["claimNext"] = async (claimOptions) => {
    if (claimOptions?.staleMs !== undefined) {
      await recoverStaleClaims({ staleMs: claimOptions.staleMs });
    }
    const blocked = new Set(
      [...(claimOptions?.blockedLaneKeys ?? [])].map((key) => key.trim()).filter(Boolean),
    );
    const candidateIds = normalizedCandidateIds(claimOptions?.candidateIds);
    if (candidateIds?.length === 0) {
      return null;
    }
    const resolveClaimLaneKey = (
      record: ChannelIngressQueueRecord<TPayload, TMetadata>,
    ): string | undefined => {
      const storedLaneKey = record.laneKey;
      if (storedLaneKey === undefined) {
        return claimOptions?.deriveLaneKey?.(record);
      }
      if (!claimOptions?.deriveLaneKey || !claimOptions.reconcileStoredLaneKey) {
        return storedLaneKey;
      }
      const derivedLaneKey = claimOptions.deriveLaneKey(record);
      if (!derivedLaneKey || derivedLaneKey === storedLaneKey) {
        return storedLaneKey;
      }
      // Durable identity changes need their channel owner's explicit approval;
      // unrelated derivations can intentionally be ephemeral claim lanes.
      return claimOptions.reconcileStoredLaneKey(record, storedLaneKey, derivedLaneKey)
        ? derivedLaneKey
        : storedLaneKey;
    };
    const database = openChannelIngressDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        let effectiveBlocked = blocked;
        if (candidateIds && candidateIds.length > 0) {
          // Candidate snapshots can race a sibling drainer. If an earlier
          // candidate is now claimed, its lane must block later same-lane rows.
          const claimedCandidateRows = executeSqliteQuerySync(
            tx.db,
            kysely
              .selectFrom("channel_ingress_events")
              .selectAll()
              .where("queue_name", "=", queueName)
              .where("status", "=", "claimed")
              .where("event_id", "in", candidateIds),
          ).rows;
          const claimedCandidateLaneKeys = claimedCandidateRows
            .map((row) => {
              if (row.lane_key && !claimOptions?.reconcileStoredLaneKey) {
                return row.lane_key;
              }
              const rec = baseRecord<TPayload, TMetadata>(row);
              return rec ? resolveClaimLaneKey(rec) : (row.lane_key ?? undefined);
            })
            .filter((laneKey): laneKey is string => Boolean(laneKey));
          if (claimedCandidateLaneKeys.length > 0) {
            effectiveBlocked = new Set([...blocked, ...claimedCandidateLaneKeys]);
          }
        }
        const baseSelect = kysely
          .selectFrom("channel_ingress_events")
          .selectAll()
          .where("queue_name", "=", queueName)
          .where("status", "=", "pending");
        let select = baseSelect;
        if (candidateIds) {
          select = select.where("event_id", "in", candidateIds);
        }
        if (effectiveBlocked.size > 0 && !claimOptions?.deriveLaneKey) {
          select = select.where((eb) =>
            eb.or([eb("lane_key", "is", null), eb("lane_key", "not in", [...effectiveBlocked])]),
          );
        }
        let orderedSelect =
          claimOptions?.orderBy === "id"
            ? select.orderBy("event_id", "asc")
            : select.orderBy("received_at", "asc").orderBy("event_id", "asc");
        orderedSelect = orderedSelect.limit(normalizeScanLimit(claimOptions?.scanLimit));
        const transitionAt = now();
        let corruptReconciliations = 0;
        let selected:
          | { row: ChannelIngressRow; record: ChannelIngressQueueRecord<TPayload, TMetadata> }
          | undefined;
        while (!selected) {
          const rows = executeSqliteQuerySync(tx.db, orderedSelect).rows;
          let tombstonedCorruptRow = false;
          for (const row of rows) {
            const rec = baseRecord<TPayload, TMetadata>(row);
            if (rec === null) {
              if (corruptReconciliations >= MAX_CORRUPT_RECONCILIATIONS_PER_CLAIM) {
                continue;
              }
              const didTombstone = tombstoneCorruptRow({
                db: tx.db,
                row,
                expectedStatus: "pending",
                failedAt: transitionAt,
                reason: "corrupt_payload",
              });
              tombstonedCorruptRow = didTombstone || tombstonedCorruptRow;
              if (didTombstone) {
                corruptReconciliations += 1;
              }
              continue;
            }
            const laneKey = resolveClaimLaneKey(rec);
            if (!laneKey || !effectiveBlocked.has(laneKey)) {
              selected = { row, record: rec };
              break;
            }
          }
          if (
            selected ||
            !tombstonedCorruptRow ||
            corruptReconciliations >= MAX_CORRUPT_RECONCILIATIONS_PER_CLAIM
          ) {
            break;
          }
        }
        if (!selected) {
          return null;
        }
        const derivedLaneKey = resolveClaimLaneKey(selected.record);
        const token = randomUUID();
        const ownerId = normalizePart(claimOptions?.ownerId, `${process.pid}`);
        const result = executeSqliteQuerySync(
          tx.db,
          kysely
            .updateTable("channel_ingress_events")
            .set({
              status: "claimed",
              claim_token: token,
              claim_owner: ownerId,
              claimed_at: transitionAt,
              ...(derivedLaneKey ? { lane_key: derivedLaneKey } : {}),
              updated_at: transitionAt,
            })
            .where("queue_name", "=", queueName)
            .where("event_id", "=", selected.row.event_id)
            .where("status", "=", "pending"),
        );
        if (affectedRows(result) === 0) {
          return null;
        }
        const row = selectRow(tx.db, queueName, selected.row.event_id);
        return row ? claimedRecord<TPayload, TMetadata>(row) : null;
      },
      { path: database.path },
    );
  };

  const claim: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["claim"] = async (
    id,
    claimOptions,
  ) => {
    const eventId = normalizePart(id, "");
    if (!eventId) {
      throw new Error("Channel ingress event id cannot be empty");
    }
    const database = openChannelIngressDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const transitionAt = now();
        const pendingRow = selectRow(tx.db, queueName, eventId);
        if (!pendingRow || pendingRow.status !== "pending") {
          return null;
        }
        if (baseRecord<TPayload, TMetadata>(pendingRow) === null) {
          tombstoneCorruptRow({
            db: tx.db,
            row: pendingRow,
            expectedStatus: "pending",
            failedAt: transitionAt,
            reason: "corrupt_payload",
          });
          return null;
        }
        const token = randomUUID();
        const ownerId = normalizePart(claimOptions?.ownerId, `${process.pid}`);
        const result = executeSqliteQuerySync(
          tx.db,
          kysely
            .updateTable("channel_ingress_events")
            .set({
              status: "claimed",
              claim_token: token,
              claim_owner: ownerId,
              claimed_at: transitionAt,
              updated_at: transitionAt,
            })
            .where("queue_name", "=", queueName)
            .where("event_id", "=", eventId)
            .where("status", "=", "pending"),
        );
        if (affectedRows(result) === 0) {
          return null;
        }
        const row = selectRow(tx.db, queueName, eventId);
        return row ? claimedRecord<TPayload, TMetadata>(row) : null;
      },
      { path: database.path },
    );
  };

  const refreshClaim: NonNullable<
    ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["refreshClaim"]
  > = async (claimRef, refreshOptions) => {
    const eventId = idFrom(claimRef);
    const refreshedAt = refreshOptions?.refreshedAt ?? now();
    const database = openChannelIngressDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) =>
        refreshChannelIngressClaimInDatabase(tx.db, {
          queueName,
          id: eventId,
          token: claimRef.claim.token,
          now: refreshedAt,
        }),
      { path: database.path },
    );
  };

  const releaseClaimIfStillStale = async (
    claimRef: ChannelIngressQueueClaimRef,
    releaseOptions: { cutoff: number; releasedAt: number },
  ): Promise<boolean> => {
    const eventId = idFrom(claimRef);
    const database = openChannelIngressDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const result = executeSqliteQuerySync(
          tx.db,
          kysely
            .updateTable("channel_ingress_events")
            .set((eb) => ({
              status: "pending",
              claim_token: null,
              claim_owner: null,
              claimed_at: null,
              attempts: eb("attempts", "+", 1),
              last_attempt_at: releaseOptions.releasedAt,
              updated_at: releaseOptions.releasedAt,
            }))
            .where("queue_name", "=", queueName)
            .where("event_id", "=", eventId)
            .where("status", "=", "claimed")
            .where("claim_token", "=", claimRef.claim.token)
            .where("claimed_at", "<=", releaseOptions.cutoff),
        );
        return affectedRows(result) > 0;
      },
      { path: database.path },
    );
  };

  const recoverStaleClaims: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["recoverStaleClaims"] = async (recoverOptions) => {
    const current = recoverOptions?.now ?? now();
    const staleMs = Math.max(0, Math.floor(recoverOptions?.staleMs ?? 0));
    const cutoff = current - staleMs;
    const database = openChannelIngressDatabase(options.stateDir);
    const claimedRows = executeSqliteQuerySync(
      database.db,
      getChannelIngressKysely(database.db)
        .selectFrom("channel_ingress_events")
        .selectAll()
        .where("queue_name", "=", queueName)
        .where("status", "=", "claimed")
        // A claimed row missing any claim column has no live owner (see
        // decodeClaimColumns); scan it regardless of claimed_at, since a NULL
        // or corrupt future timestamp would dodge every cutoff comparison.
        .where((eb) =>
          eb.or([
            eb("claimed_at", "<=", cutoff),
            eb("claimed_at", "is", null),
            eb("claim_token", "is", null),
            eb("claim_owner", "is", null),
            eb("claim_token", "=", ""),
            eb("claim_owner", "=", ""),
          ]),
        ),
    ).rows;
    let recovered = 0;
    for (const row of claimedRows) {
      const claimColumns = decodeClaimColumns(row);
      const claimRec = claimColumns === null ? null : claimedRecord<TPayload, TMetadata>(row);
      if (claimRec === null) {
        if (claimColumns !== null) {
          const shouldRecoverCorrupt = recoverOptions?.shouldRecoverCorrupt;
          if (shouldRecoverCorrupt) {
            if (!(await shouldRecoverCorrupt(corruptClaimRecord(row, claimColumns)))) {
              continue;
            }
          } else if (recoverOptions?.shouldRecover) {
            // Existing payload-aware policies cannot safely decide on corrupt
            // data. Preserve ownership unless the caller opts into the raw claim
            // identity contract above.
            continue;
          }
        }
        // claimColumns === null: no reachable owner can exist, so no policy
        // consult — tombstone unconditionally to keep the queue recoverable.
        const tombstoned = runOpenClawStateWriteTransaction(
          (tx) =>
            tombstoneCorruptRow({
              db: tx.db,
              row,
              expectedStatus: "claimed",
              failedAt: current,
              // Malformed claims skip the stale guard: their claimed_at may be
              // NULL or a corrupt future value; the exact-token guard fences.
              ...(claimColumns === null ? {} : { staleCutoff: cutoff }),
              reason: claimColumns === null ? "corrupt_claim" : "corrupt_payload",
            }),
          { path: database.path },
        );
        if (tombstoned) {
          recovered += 1;
        }
        continue;
      }
      if (recoverOptions?.shouldRecover && !(await recoverOptions.shouldRecover(claimRec))) {
        continue;
      }
      if (await releaseClaimIfStillStale(claimRec, { cutoff, releasedAt: current })) {
        recovered += 1;
      }
    }
    return recovered;
  };

  const complete: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["complete"] = async (
    idOrClaim,
    completeOptions,
  ) => {
    const eventId = idFrom(idOrClaim);
    const token = claimTokenFrom(idOrClaim);
    const completedAt = completeOptions?.completedAt ?? now();
    const database = openChannelIngressDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const baseUpdate = kysely
          .updateTable("channel_ingress_events")
          .set({
            status: "completed",
            completed_at: completedAt,
            completed_metadata_json:
              completeOptions?.metadata === undefined
                ? null
                : JSON.stringify(completeOptions.metadata),
            payload_json: "null",
            metadata_json: null,
            claim_token: null,
            claim_owner: null,
            claimed_at: null,
            last_attempt_at: null,
            last_error: null,
            updated_at: completedAt,
          })
          .where("queue_name", "=", queueName)
          .where("event_id", "=", eventId);
        const update =
          token === null
            ? baseUpdate.where("status", "=", "pending")
            : baseUpdate.where("status", "=", "claimed").where("claim_token", "=", token);
        const result = executeSqliteQuerySync(tx.db, update);
        if (affectedRows(result) > 0) {
          return true;
        }
        if (token !== null) {
          return false;
        }
        const insert = executeSqliteQuerySync(
          tx.db,
          kysely
            .insertInto("channel_ingress_events")
            .values({
              queue_name: queueName,
              event_id: eventId,
              channel_id: channelId,
              account_id: accountId,
              status: "completed",
              lane_key: null,
              payload_json: "null",
              metadata_json: null,
              received_at: completedAt,
              updated_at: completedAt,
              attempts: 0,
              completed_at: completedAt,
              completed_metadata_json:
                completeOptions?.metadata === undefined
                  ? null
                  : JSON.stringify(completeOptions.metadata),
            })
            .onConflict((conflict) => conflict.columns(["queue_name", "event_id"]).doNothing()),
        );
        return affectedRows(insert) > 0;
      },
      { path: database.path },
    );
  };

  const release: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["release"] = async (
    idOrClaim,
    releaseOptions,
  ) => {
    const eventId = idFrom(idOrClaim);
    const token = claimTokenFrom(idOrClaim);
    const releasedAt = releaseOptions?.releasedAt ?? now();
    const database = openChannelIngressDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) =>
        releaseChannelIngressInDatabase(tx.db, {
          queueName,
          id: eventId,
          token,
          now: releasedAt,
          recordAttempt: releaseOptions?.recordAttempt,
          lastError: releaseOptions?.lastError,
        }),
      { path: database.path },
    );
  };

  const fail: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["fail"] = async (
    idOrClaim,
    failOptions,
  ) => {
    const eventId = idFrom(idOrClaim);
    const token = claimTokenFrom(idOrClaim);
    const failedAt = failOptions.failedAt ?? now();
    const database = openChannelIngressDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) =>
        failChannelIngressInDatabase(tx.db, {
          queueName,
          id: eventId,
          token,
          now: failedAt,
          reason: failOptions.reason,
          message: failOptions.message,
        }),
      { path: database.path },
    );
  };

  const resubmit: NonNullable<
    ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["resubmit"]
  > = async (id, resubmitOptions) => {
    const eventId = idFrom(id);
    const resubmittedAt = resubmitOptions?.resubmittedAt ?? now();
    const database = openChannelIngressDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const row = selectRow(tx.db, queueName, eventId);
        if (!row) {
          return { kind: "not-found" };
        }
        if (row.status === "completed") {
          return { kind: "completed", record: completedRecord<TCompletedMetadata>(row) };
        }
        if (row.status !== "failed") {
          return {
            kind: "active",
            status: row.status === "claimed" ? "claimed" : "pending",
          };
        }
        const previous = failedRecord<TPayload, TMetadata>(row);
        // Pre-retention tombstones and corrupt-payload failures stored JSON null.
        // Refuse them rather than enqueueing an event with invented payload data.
        if (row.payload_json === "null" || !parseFailedPayload(row.payload_json).ok) {
          return { kind: "unrecoverable", record: previous };
        }
        const result = executeSqliteQuerySync(
          tx.db,
          getChannelIngressKysely(tx.db)
            .updateTable("channel_ingress_events")
            .set({
              status: "pending",
              payload_json:
                row.payload_json === FAILED_NULL_PAYLOAD_SENTINEL ? "null" : row.payload_json,
              received_at: resubmittedAt,
              updated_at: resubmittedAt,
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
            .where("queue_name", "=", queueName)
            .where("event_id", "=", eventId)
            .where("status", "=", "failed"),
        );
        if (affectedRows(result) === 0) {
          return { kind: "active", status: "pending" };
        }
        const updated = selectRow(tx.db, queueName, eventId);
        const record = updated ? baseRecord<TPayload, TMetadata>(updated) : null;
        if (!record) {
          throw new Error(
            `Failed to read resubmitted channel ingress event ${queueName}/${eventId}`,
          );
        }
        return { kind: "resubmitted", record, previous };
      },
      { path: database.path },
    );
  };

  const deleteEntry: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["delete"] = async (idOrRecord) => {
    const eventId = idFrom(idOrRecord);
    const token = claimTokenFrom(idOrRecord);
    const database = openChannelIngressDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const baseDelete = kysely
          .deleteFrom("channel_ingress_events")
          .where("queue_name", "=", queueName)
          .where("event_id", "=", eventId);
        const deleteQuery =
          token === null
            ? baseDelete.where("status", "=", "pending")
            : baseDelete.where("status", "=", "claimed").where("claim_token", "=", token);
        return affectedRows(executeSqliteQuerySync(tx.db, deleteQuery)) > 0;
      },
      { path: database.path },
    );
  };

  const purge: NonNullable<
    ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["purge"]
  > = async () => {
    const database = openChannelIngressDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) =>
        affectedRows(
          executeSqliteQuerySync(
            tx.db,
            getChannelIngressKysely(tx.db)
              .deleteFrom("channel_ingress_events")
              .where("queue_name", "=", queueName),
          ),
        ),
      { path: database.path },
    );
  };

  const prune: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["prune"] = async (
    pruneOptions,
  ) => {
    const current = pruneOptions?.now ?? now();
    const pendingCutoff =
      pruneOptions?.pendingTtlMs === undefined ? null : current - pruneOptions.pendingTtlMs;
    const completedCutoff =
      pruneOptions?.completedTtlMs === undefined ? null : current - pruneOptions.completedTtlMs;
    const failedCutoff =
      pruneOptions?.failedTtlMs === undefined ? null : current - pruneOptions.failedTtlMs;
    const pendingMaxEntries = normalizeMaxEntries(pruneOptions?.pendingMaxEntries);
    const completedMaxEntries = normalizeMaxEntries(pruneOptions?.completedMaxEntries);
    const failedMaxEntries = normalizeMaxEntries(pruneOptions?.failedMaxEntries);
    const protectIds = normalizedProtectedIds(pruneOptions?.protectIds);
    if (
      pendingCutoff === null &&
      completedCutoff === null &&
      failedCutoff === null &&
      pendingMaxEntries === null &&
      completedMaxEntries === null &&
      failedMaxEntries === null
    ) {
      return 0;
    }
    const context = captureOpenClawStateWorkerContext({
      env: resolveChannelIngressStateEnv(options.stateDir),
    });
    const input = {
      queueName,
      pendingCutoff,
      completedCutoff,
      failedCutoff,
      pendingMaxEntries,
      completedMaxEntries,
      failedMaxEntries,
      protectIds,
    };
    const assertCurrent = () => {
      context.admission.assertCurrent();
      assertPruneCurrent?.();
    };
    assertCurrent();
    const [{ runOpenClawStateWorkerOperation }, { createSqliteWorkerWriteAdmission }] =
      await Promise.all([
        import("../../state/openclaw-state-worker-store.js"),
        import("../../infra/sqlite-worker-store.js"),
      ]);
    return runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "channelIngress.prune", input }),
      {
        requireStateLifecycle: true,
        assertCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
          context.admission.databasePath,
        ]),
      },
    );
  };

  return {
    enqueue,
    listPending,
    listClaims,
    listFailed,
    claimNext,
    claim,
    refreshClaim,
    complete,
    release,
    fail,
    resubmit,
    delete: deleteEntry,
    recoverStaleClaims,
    prune,
    purge,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
