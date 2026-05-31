import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";

type QueueStatus = "pending" | "failed";

export type DeliveryQueueRowMetadata = {
  entryKind?: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
};

export type DeliveryQueueEntryState = {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  platformSendStartedAt?: number;
  recoveryState?: string;
};

type QueueRow = {
  id: string;
  entry_json: string;
  enqueued_at: number | bigint;
  retry_count: number | bigint;
  last_attempt_at: number | bigint | null;
  last_error: string | null;
  platform_send_started_at: number | bigint | null;
  recovery_state: string | null;
};

function db(stateDir?: string) {
  return openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
}

function enoent(queueName: string, id: string): Error & { code: string } {
  const err = new Error(`No pending ${queueName} delivery queue entry ${id}`) as Error & {
    code: string;
  };
  err.code = "ENOENT";
  return err;
}

function inflate(row: QueueRow): DeliveryQueueEntryState {
  return {
    ...(JSON.parse(row.entry_json) as DeliveryQueueEntryState),
    id: row.id,
    enqueuedAt: Number(row.enqueued_at),
    retryCount: Number(row.retry_count),
    ...(row.last_attempt_at == null ? {} : { lastAttemptAt: Number(row.last_attempt_at) }),
    ...(row.last_error == null ? {} : { lastError: row.last_error }),
    ...(row.platform_send_started_at == null
      ? {}
      : { platformSendStartedAt: Number(row.platform_send_started_at) }),
    ...(row.recovery_state == null ? {} : { recoveryState: row.recovery_state }),
  };
}

function metadata(entry: DeliveryQueueEntryState): DeliveryQueueRowMetadata {
  const item = entry as DeliveryQueueEntryState & {
    kind?: string;
    sessionKey?: string;
    channel?: string;
    to?: string;
    accountId?: string;
    session?: { key?: string };
    route?: { channel?: string; to?: string; accountId?: string };
    deliveryContext?: { channel?: string; to?: string; accountId?: string };
  };
  return {
    entryKind: item.kind,
    sessionKey: item.sessionKey ?? item.session?.key,
    channel: item.channel ?? item.route?.channel ?? item.deliveryContext?.channel,
    target: item.to ?? item.route?.to ?? item.deliveryContext?.to,
    accountId: item.accountId ?? item.route?.accountId ?? item.deliveryContext?.accountId,
  };
}

export function upsertDeliveryQueueEntry(params: {
  queueName: string;
  entry: DeliveryQueueEntryState;
  metadata?: DeliveryQueueRowMetadata;
  status?: QueueStatus;
  stateDir?: string;
}): void {
  const now = Date.now();
  const status = params.status ?? "pending";
  const meta = params.metadata ?? metadata(params.entry);
  db(params.stateDir)
    .db.prepare(
      `
        INSERT INTO delivery_queue_entries (
          queue_name, id, status, entry_kind, session_key, channel, target, account_id,
          retry_count, last_attempt_at, last_error, recovery_state, platform_send_started_at,
          entry_json, enqueued_at, updated_at, failed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(queue_name, id) DO UPDATE SET
          status = excluded.status, entry_kind = excluded.entry_kind,
          session_key = excluded.session_key, channel = excluded.channel,
          target = excluded.target, account_id = excluded.account_id,
          retry_count = excluded.retry_count, last_attempt_at = excluded.last_attempt_at,
          last_error = excluded.last_error, recovery_state = excluded.recovery_state,
          platform_send_started_at = excluded.platform_send_started_at,
          entry_json = excluded.entry_json, enqueued_at = excluded.enqueued_at,
          updated_at = excluded.updated_at, failed_at = excluded.failed_at
      `,
    )
    .run(
      params.queueName,
      params.entry.id,
      status,
      meta.entryKind ?? null,
      meta.sessionKey ?? null,
      meta.channel ?? null,
      meta.target ?? null,
      meta.accountId ?? null,
      params.entry.retryCount,
      params.entry.lastAttemptAt ?? null,
      params.entry.lastError ?? null,
      params.entry.recoveryState ?? null,
      params.entry.platformSendStartedAt ?? null,
      JSON.stringify(params.entry),
      params.entry.enqueuedAt,
      now,
      status === "failed" ? now : null,
    );
}

export function loadDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir?: string,
): DeliveryQueueEntryState | null {
  const row = db(stateDir)
    .db.prepare(
      `SELECT id, entry_json, enqueued_at, retry_count, last_attempt_at, last_error,
              platform_send_started_at, recovery_state
         FROM delivery_queue_entries
        WHERE queue_name = ? AND id = ? AND status = 'pending'`,
    )
    .get(queueName, id) as QueueRow | undefined;
  return row ? inflate(row) : null;
}

export function loadDeliveryQueueEntries(
  queueName: string,
  stateDir?: string,
): DeliveryQueueEntryState[] {
  const rows = db(stateDir)
    .db.prepare(
      `SELECT id, entry_json, enqueued_at, retry_count, last_attempt_at, last_error,
              platform_send_started_at, recovery_state
         FROM delivery_queue_entries
        WHERE queue_name = ? AND status = 'pending'
        ORDER BY enqueued_at ASC, id ASC`,
    )
    .all(queueName) as QueueRow[];
  return rows.map(inflate);
}

export function deleteDeliveryQueueEntry(queueName: string, id: string, stateDir?: string): void {
  db(stateDir)
    .db.prepare(
      "DELETE FROM delivery_queue_entries WHERE queue_name = ? AND id = ? AND status = 'pending'",
    )
    .run(queueName, id);
}

export function updateDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir: string | undefined,
  update: (entry: DeliveryQueueEntryState) => DeliveryQueueEntryState,
): void {
  const current = loadDeliveryQueueEntry(queueName, id, stateDir);
  if (!current) {
    throw enoent(queueName, id);
  }
  upsertDeliveryQueueEntry({ queueName, entry: update(current), stateDir });
}

export function moveDeliveryQueueEntryToFailed(
  queueName: string,
  id: string,
  stateDir?: string,
): void {
  const current = loadDeliveryQueueEntry(queueName, id, stateDir);
  if (!current) {
    throw enoent(queueName, id);
  }
  upsertDeliveryQueueEntry({ queueName, entry: current, status: "failed", stateDir });
}
