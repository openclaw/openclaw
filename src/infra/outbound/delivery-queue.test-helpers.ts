import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../kysely-sync.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import type { DeliverFn, RecoveryLogger } from "./delivery-queue.js";

type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;

type DeliveryQueueEntryRow = {
  entry_json: string;
  enqueued_at?: number;
  last_attempt_at?: number | null;
  last_error?: string | null;
  platform_send_started_at?: number | null;
  recovery_state?: string | null;
  retry_count?: number;
};

const QUEUE_NAME = "outbound-delivery";

function databaseOptions(tmpDir: string) {
  return { env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } };
}

function parseEntry(row: DeliveryQueueEntryRow | undefined, id: string): Record<string, unknown> {
  if (!row) {
    throw new Error(`missing queued delivery test entry: ${id}`);
  }
  const entry = JSON.parse(row.entry_json) as Record<string, unknown>;
  if (typeof row.enqueued_at === "number") {
    entry.enqueuedAt = row.enqueued_at;
  }
  if (typeof row.retry_count === "number") {
    entry.retryCount = row.retry_count;
  }
  if (typeof row.last_attempt_at === "number") {
    entry.lastAttemptAt = row.last_attempt_at;
  } else if (row.last_attempt_at === null) {
    delete entry.lastAttemptAt;
  }
  if (typeof row.last_error === "string") {
    entry.lastError = row.last_error;
  } else if (row.last_error === null) {
    delete entry.lastError;
  }
  if (typeof row.platform_send_started_at === "number") {
    entry.platformSendStartedAt = row.platform_send_started_at;
  } else if (row.platform_send_started_at === null) {
    delete entry.platformSendStartedAt;
  }
  if (
    row.recovery_state === "send_attempt_started" ||
    row.recovery_state === "unknown_after_send"
  ) {
    entry.recoveryState = row.recovery_state;
  } else if (row.recovery_state === null) {
    delete entry.recoveryState;
  }
  return entry;
}

export function installDeliveryQueueTmpDirHooks(): { readonly tmpDir: () => string } {
  let tmpDir = "";
  let fixtureRoot = "";
  let fixtureCount = 0;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-suite-"));
  });

  beforeEach(() => {
    tmpDir = path.join(fixtureRoot, `case-${fixtureCount++}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    closeOpenClawStateDatabaseForTest();
    if (!fixtureRoot) {
      return;
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = "";
  });

  return {
    tmpDir: () => tmpDir,
  };
}

export function readQueuedEntry(tmpDir: string, id: string): Record<string, unknown> {
  const stateDatabase = openOpenClawStateDatabase(databaseOptions(tmpDir));
  const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
  const row = executeSqliteQueryTakeFirstSync(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .select([
        "entry_json",
        "enqueued_at",
        "last_attempt_at",
        "last_error",
        "platform_send_started_at",
        "recovery_state",
        "retry_count",
      ])
      .where("queue_name", "=", QUEUE_NAME)
      .where("id", "=", id)
      .where("status", "=", "pending"),
  );
  return parseEntry(row, id);
}

export function readQueuedEntryStorageFields(
  tmpDir: string,
  id: string,
): Record<string, unknown> | undefined {
  const stateDatabase = openOpenClawStateDatabase(databaseOptions(tmpDir));
  const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
  return executeSqliteQueryTakeFirstSync(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .select([
        "account_id",
        "channel",
        "entry_kind",
        "last_attempt_at",
        "last_error",
        "platform_send_started_at",
        "recovery_state",
        "retry_count",
        "session_key",
        "target",
      ])
      .where("queue_name", "=", QUEUE_NAME)
      .where("id", "=", id),
  );
}

export function readFailedQueuedEntry(tmpDir: string, id: string): Record<string, unknown> | null {
  const stateDatabase = openOpenClawStateDatabase(databaseOptions(tmpDir));
  const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
  const row = executeSqliteQueryTakeFirstSync(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .select([
        "entry_json",
        "enqueued_at",
        "last_attempt_at",
        "last_error",
        "platform_send_started_at",
        "recovery_state",
        "retry_count",
      ])
      .where("queue_name", "=", QUEUE_NAME)
      .where("id", "=", id)
      .where("status", "=", "failed"),
  );
  return row ? parseEntry(row, id) : null;
}

export function readPendingQueuedEntries(tmpDir: string): Record<string, unknown>[] {
  const stateDatabase = openOpenClawStateDatabase(databaseOptions(tmpDir));
  const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
  return executeSqliteQuerySync(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .select([
        "entry_json",
        "enqueued_at",
        "last_attempt_at",
        "last_error",
        "platform_send_started_at",
        "recovery_state",
        "retry_count",
      ])
      .where("queue_name", "=", QUEUE_NAME)
      .where("status", "=", "pending")
      .orderBy("enqueued_at", "asc")
      .orderBy("id", "asc"),
  ).rows.map((row) => parseEntry(row, "pending-list-entry"));
}

export function writeQueuedEntryJsonForTest(
  tmpDir: string,
  id: string,
  entry: Record<string, unknown>,
): void {
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .updateTable("delivery_queue_entries")
        .set({
          entry_json: JSON.stringify(entry),
          updated_at: Date.now(),
        })
        .where("queue_name", "=", QUEUE_NAME)
        .where("id", "=", id)
        .where("status", "=", "pending"),
    );
  }, databaseOptions(tmpDir));
}

export function setQueuedEntryState(
  tmpDir: string,
  id: string,
  state: {
    retryCount: number;
    lastAttemptAt?: number;
    enqueuedAt?: number;
    platformSendStartedAt?: number;
    recoveryState?: "send_attempt_started" | "unknown_after_send";
    lastError?: string;
  },
): void {
  const entry = readQueuedEntry(tmpDir, id);
  entry.retryCount = state.retryCount;
  if (state.lastAttemptAt === undefined) {
    delete entry.lastAttemptAt;
  } else {
    entry.lastAttemptAt = state.lastAttemptAt;
  }
  if (state.enqueuedAt !== undefined) {
    entry.enqueuedAt = state.enqueuedAt;
  }
  if (state.platformSendStartedAt !== undefined) {
    entry.platformSendStartedAt = state.platformSendStartedAt;
  }
  if (state.recoveryState !== undefined) {
    entry.recoveryState = state.recoveryState;
  }
  if (state.lastError !== undefined) {
    entry.lastError = state.lastError;
  }
  const stateDatabaseOptions = databaseOptions(tmpDir);
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .updateTable("delivery_queue_entries")
        .set({
          entry_json: JSON.stringify(entry),
          enqueued_at: typeof entry.enqueuedAt === "number" ? entry.enqueuedAt : Date.now(),
          last_attempt_at:
            typeof entry.lastAttemptAt === "number" && Number.isFinite(entry.lastAttemptAt)
              ? entry.lastAttemptAt
              : null,
          last_error: typeof entry.lastError === "string" ? entry.lastError : null,
          platform_send_started_at:
            typeof entry.platformSendStartedAt === "number" &&
            Number.isFinite(entry.platformSendStartedAt)
              ? entry.platformSendStartedAt
              : null,
          recovery_state:
            entry.recoveryState === "send_attempt_started" ||
            entry.recoveryState === "unknown_after_send"
              ? entry.recoveryState
              : null,
          retry_count:
            typeof entry.retryCount === "number" && Number.isFinite(entry.retryCount)
              ? entry.retryCount
              : 0,
          updated_at: Date.now(),
        })
        .where("queue_name", "=", QUEUE_NAME)
        .where("id", "=", id)
        .where("status", "=", "pending"),
    );
  }, stateDatabaseOptions);
}

export function createRecoveryLog(): RecoveryLogger & {
  info: ReturnType<typeof vi.fn<(msg: string) => void>>;
  warn: ReturnType<typeof vi.fn<(msg: string) => void>>;
  error: ReturnType<typeof vi.fn<(msg: string) => void>>;
} {
  return {
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
  };
}

export function asDeliverFn(deliver: ReturnType<typeof vi.fn>): DeliverFn {
  return deliver as DeliverFn;
}
