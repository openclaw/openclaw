// SQLite-backed durable storage for Gateway webhook queues.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import type { CronSessionTarget } from "../cron/types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { HookAgentDispatchPayload } from "./hooks.js";

export type HookQueueItemStatus = "queued" | "running" | "ok" | "error";

export type QueuedHookAgentPayload = HookAgentDispatchPayload & {
  sessionTarget: CronSessionTarget;
};

export type HookQueueItem = {
  itemId: string;
  queueId: string;
  status: HookQueueItemStatus;
  runId: string;
  jobId: string;
  sourcePath: string;
  name: string;
  messagePreview: string;
  agentId?: string;
  sessionKey: string;
  sessionTarget: CronSessionTarget;
  payload: QueuedHookAgentPayload;
  createdAtMs: number;
  claimedAtMs?: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  updatedAtMs: number;
  error?: string;
  summary?: string;
};

export type HookQueueSummaryCounts = Record<HookQueueItemStatus, number>;

export type HookQueueCountSnapshot = {
  queueId: string;
  counts: HookQueueSummaryCounts;
  paused: boolean;
  pausedAtMs?: number;
  stateUpdatedAtMs?: number;
  oldestQueuedAtMs?: number;
  newestQueuedAtMs?: number;
};

type HookQueueItemsTable = OpenClawStateKyselyDatabase["hook_queue_items"];
type HookQueueStateTable = OpenClawStateKyselyDatabase["hook_queue_state"];
type HookQueueStoreDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "hook_queue_items" | "hook_queue_state"
>;
type HookQueueItemRow = Selectable<HookQueueItemsTable>;
type HookQueueStateRow = Selectable<HookQueueStateTable>;
type CountRow = {
  queue_id: string;
  status: string;
  count: number | bigint;
};
type QueueBoundsRow = {
  queue_id: string;
  oldest_queued_at_ms: number | null;
  newest_queued_at_ms: number | null;
};

const HOOK_QUEUE_STATUSES: readonly HookQueueItemStatus[] = ["queued", "running", "ok", "error"];
const HOOK_QUEUE_STATUS_SET = new Set<string>(HOOK_QUEUE_STATUSES);
const DEFAULT_QUEUE_ITEM_LIMIT = 50;
const MAX_QUEUE_ITEM_LIMIT = 200;

function getHookQueueKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<HookQueueStoreDatabase>(db);
}

function createEmptyCounts(): HookQueueSummaryCounts {
  return {
    queued: 0,
    running: 0,
    ok: 0,
    error: 0,
  };
}

function createEmptySnapshot(queueId: string): HookQueueCountSnapshot {
  return {
    queueId,
    counts: createEmptyCounts(),
    paused: false,
  };
}

function parseHookQueueStatus(value: string): HookQueueItemStatus {
  if (HOOK_QUEUE_STATUS_SET.has(value)) {
    return value as HookQueueItemStatus;
  }
  return "error";
}

function parsePayloadJson(raw: string): QueuedHookAgentPayload {
  return JSON.parse(raw) as QueuedHookAgentPayload;
}

function rowToHookQueueItem(row: HookQueueItemRow): HookQueueItem {
  const claimedAtMs = normalizeSqliteNumber(row.claimed_at_ms);
  const startedAtMs = normalizeSqliteNumber(row.started_at_ms);
  const finishedAtMs = normalizeSqliteNumber(row.finished_at_ms);
  return {
    itemId: row.item_id,
    queueId: row.queue_id,
    status: parseHookQueueStatus(row.status),
    runId: row.run_id,
    jobId: row.job_id,
    sourcePath: row.source_path,
    name: row.name,
    messagePreview: row.message_preview,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    sessionKey: row.session_key,
    sessionTarget: row.session_target as CronSessionTarget,
    payload: parsePayloadJson(row.payload_json),
    createdAtMs: normalizeSqliteNumber(row.created_at_ms) ?? 0,
    ...(claimedAtMs != null ? { claimedAtMs } : {}),
    ...(startedAtMs != null ? { startedAtMs } : {}),
    ...(finishedAtMs != null ? { finishedAtMs } : {}),
    updatedAtMs: normalizeSqliteNumber(row.updated_at_ms) ?? 0,
    ...(row.error ? { error: row.error } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
  };
}

function bindHookQueueItem(input: {
  itemId: string;
  queueId: string;
  runId: string;
  jobId: string;
  sourcePath: string;
  payload: QueuedHookAgentPayload;
  nowMs: number;
}): Insertable<HookQueueItemsTable> {
  const payload = input.payload;
  return {
    item_id: input.itemId,
    queue_id: input.queueId,
    status: "queued",
    run_id: input.runId,
    job_id: input.jobId,
    source_path: input.sourcePath,
    name: payload.name,
    message_preview: payload.message.slice(0, 500),
    agent_id: payload.agentId ?? null,
    session_key: payload.sessionKey,
    session_target: payload.sessionTarget,
    payload_json: JSON.stringify(payload),
    created_at_ms: input.nowMs,
    claimed_at_ms: null,
    started_at_ms: null,
    finished_at_ms: null,
    updated_at_ms: input.nowMs,
    error: null,
    summary: null,
  };
}

function selectHookQueueItemById(db: DatabaseSync, itemId: string): HookQueueItem | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getHookQueueKysely(db).selectFrom("hook_queue_items").selectAll().where("item_id", "=", itemId),
  );
  return row ? rowToHookQueueItem(row) : null;
}

function readHookQueuePausedInTransaction(db: DatabaseSync, queueId: string): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getHookQueueKysely(db)
      .selectFrom("hook_queue_state")
      .select("paused")
      .where("queue_id", "=", queueId),
  ) as { paused?: number | null } | undefined;
  return row?.paused === 1;
}

export function setHookQueuePaused(input: { queueId: string; paused: boolean; nowMs?: number }): {
  queueId: string;
  paused: boolean;
  pausedAtMs: number | null;
  updatedAtMs: number;
} {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const nowMs = input.nowMs ?? Date.now();
    executeSqliteQuerySync(
      db,
      getHookQueueKysely(db)
        .insertInto("hook_queue_state")
        .values({
          queue_id: input.queueId,
          paused: input.paused ? 1 : 0,
          paused_at_ms: input.paused ? nowMs : null,
          updated_at_ms: nowMs,
        })
        .onConflict((oc) =>
          oc.column("queue_id").doUpdateSet({
            paused: input.paused ? 1 : 0,
            paused_at_ms: input.paused ? nowMs : null,
            updated_at_ms: nowMs,
          }),
        ),
    );
    return {
      queueId: input.queueId,
      paused: input.paused,
      pausedAtMs: input.paused ? nowMs : null,
      updatedAtMs: nowMs,
    };
  });
}

export function enqueueHookQueueItem(input: {
  itemId: string;
  queueId: string;
  runId: string;
  jobId: string;
  sourcePath: string;
  payload: QueuedHookAgentPayload;
  nowMs?: number;
}): HookQueueItem {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const nowMs = input.nowMs ?? Date.now();
    executeSqliteQuerySync(
      db,
      getHookQueueKysely(db)
        .insertInto("hook_queue_items")
        .values(
          bindHookQueueItem({
            ...input,
            nowMs,
          }),
        ),
    );
    const item = selectHookQueueItemById(db, input.itemId);
    if (!item) {
      throw new Error(`failed to enqueue hook queue item: ${input.itemId}`);
    }
    return item;
  });
}

export function claimNextHookQueueItem(input: {
  queueId: string;
  nowMs?: number;
}): HookQueueItem | null {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getHookQueueKysely(db);
    if (readHookQueuePausedInTransaction(db, input.queueId)) {
      return null;
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("hook_queue_items")
        .selectAll()
        .where("queue_id", "=", input.queueId)
        .where("status", "=", "queued")
        .orderBy("created_at_ms", "asc")
        // UUID item ids are random; sequence preserves FIFO for burst enqueues
        // that share the same millisecond timestamp.
        .orderBy("sequence", "asc")
        .limit(1),
    );
    if (!row) {
      return null;
    }
    const nowMs = input.nowMs ?? Date.now();
    const result = executeSqliteQuerySync(
      db,
      kysely
        .updateTable("hook_queue_items")
        .set({
          status: "running",
          claimed_at_ms: nowMs,
          started_at_ms: nowMs,
          updated_at_ms: nowMs,
          error: null,
        })
        .where("item_id", "=", row.item_id)
        .where("status", "=", "queued"),
    );
    if (Number(result.numAffectedRows ?? 0) <= 0) {
      return null;
    }
    return selectHookQueueItemById(db, row.item_id);
  });
}

export function finishHookQueueItem(input: {
  itemId: string;
  status: Extract<HookQueueItemStatus, "ok" | "error">;
  summary?: string;
  error?: string;
  nowMs?: number;
}): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const nowMs = input.nowMs ?? Date.now();
    executeSqliteQuerySync(
      db,
      getHookQueueKysely(db)
        .updateTable("hook_queue_items")
        .set({
          status: input.status,
          finished_at_ms: nowMs,
          updated_at_ms: nowMs,
          summary: input.summary ?? null,
          error: input.error ?? null,
        })
        .where("item_id", "=", input.itemId),
    );
  });
}

export function failHookQueueItem(input: {
  itemId: string;
  error: string;
  summary?: string;
  nowMs?: number;
}): void {
  finishHookQueueItem({
    itemId: input.itemId,
    status: "error",
    summary: input.summary ?? input.error,
    error: input.error,
    nowMs: input.nowMs,
  });
}

export function requeueRunningHookQueueItems(input: {
  queueIds?: readonly string[];
  nowMs?: number;
}) {
  runOpenClawStateWriteTransaction(({ db }) => {
    const nowMs = input.nowMs ?? Date.now();
    let query = getHookQueueKysely(db)
      .updateTable("hook_queue_items")
      .set({
        status: "queued",
        claimed_at_ms: null,
        started_at_ms: null,
        updated_at_ms: nowMs,
      })
      .where("status", "=", "running");
    if (input.queueIds && input.queueIds.length > 0) {
      query = query.where("queue_id", "in", Array.from(input.queueIds));
    }
    executeSqliteQuerySync(db, query);
  });
}

export function listHookQueueItems(input: {
  queueId?: string;
  statuses?: readonly HookQueueItemStatus[];
  limit?: number;
  offset?: number;
}): {
  items: HookQueueItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
} {
  const limit = Math.max(
    1,
    Math.min(MAX_QUEUE_ITEM_LIMIT, Math.floor(input.limit ?? DEFAULT_QUEUE_ITEM_LIMIT)),
  );
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getHookQueueKysely(db);
    let base = kysely.selectFrom("hook_queue_items");
    if (input.queueId) {
      base = base.where("queue_id", "=", input.queueId);
    }
    const statuses = input.statuses?.filter((status) => HOOK_QUEUE_STATUS_SET.has(status));
    if (statuses && statuses.length > 0) {
      base = base.where("status", "in", Array.from(statuses));
    }
    const countRow = executeSqliteQueryTakeFirstSync(
      db,
      base.select(({ fn }) => fn.countAll<number>().as("count")),
    ) as { count?: number | bigint } | undefined;
    const total = Number(countRow?.count ?? 0);
    const rows = executeSqliteQuerySync(
      db,
      base
        .selectAll()
        .orderBy("created_at_ms", "desc")
        .orderBy("sequence", "desc")
        .limit(limit)
        .offset(offset),
    ).rows;
    const items = rows.map(rowToHookQueueItem);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < total;
    return {
      items,
      total,
      offset,
      limit,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
    };
  });
}

export function summarizeHookQueueItems(queueIds: readonly string[]): HookQueueCountSnapshot[] {
  const snapshots = new Map<string, HookQueueCountSnapshot>();
  for (const queueId of queueIds) {
    snapshots.set(queueId, createEmptySnapshot(queueId));
  }
  if (queueIds.length === 0) {
    return [];
  }

  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getHookQueueKysely(db);
    const countRows = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("hook_queue_items")
        .select(["queue_id", "status"])
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("queue_id", "in", Array.from(queueIds))
        .groupBy(["queue_id", "status"]),
    ).rows as CountRow[];
    for (const row of countRows) {
      const snapshot = snapshots.get(row.queue_id);
      if (!snapshot) {
        continue;
      }
      const status = parseHookQueueStatus(row.status);
      snapshot.counts[status] = Number(row.count ?? 0);
    }

    const boundRows = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("hook_queue_items")
        .select("queue_id")
        .select(({ fn }) => [
          fn.min<number>("created_at_ms").as("oldest_queued_at_ms"),
          fn.max<number>("created_at_ms").as("newest_queued_at_ms"),
        ])
        .where("queue_id", "in", Array.from(queueIds))
        .where("status", "=", "queued")
        .groupBy("queue_id"),
    ).rows as QueueBoundsRow[];
    for (const row of boundRows) {
      const snapshot = snapshots.get(row.queue_id);
      if (!snapshot) {
        continue;
      }
      const oldestQueuedAtMs = normalizeSqliteNumber(row.oldest_queued_at_ms);
      const newestQueuedAtMs = normalizeSqliteNumber(row.newest_queued_at_ms);
      if (oldestQueuedAtMs != null) {
        snapshot.oldestQueuedAtMs = oldestQueuedAtMs;
      }
      if (newestQueuedAtMs != null) {
        snapshot.newestQueuedAtMs = newestQueuedAtMs;
      }
    }

    const stateRows = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("hook_queue_state")
        .selectAll()
        .where("queue_id", "in", Array.from(queueIds)),
    ).rows as HookQueueStateRow[];
    for (const row of stateRows) {
      const snapshot = snapshots.get(row.queue_id);
      if (!snapshot) {
        continue;
      }
      snapshot.paused = row.paused === 1;
      const pausedAtMs = normalizeSqliteNumber(row.paused_at_ms);
      const stateUpdatedAtMs = normalizeSqliteNumber(row.updated_at_ms);
      if (pausedAtMs != null) {
        snapshot.pausedAtMs = pausedAtMs;
      }
      if (stateUpdatedAtMs != null) {
        snapshot.stateUpdatedAtMs = stateUpdatedAtMs;
      }
    }
    return queueIds.map((queueId) => snapshots.get(queueId) ?? createEmptySnapshot(queueId));
  });
}
