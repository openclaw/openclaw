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
};

const QUEUE_NAME = "outbound-delivery";

function databaseOptions(tmpDir: string) {
  return { env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } };
}

function parseEntry(row: DeliveryQueueEntryRow | undefined, id: string): Record<string, unknown> {
  if (!row) {
    throw new Error(`missing queued delivery test entry: ${id}`);
  }
  return JSON.parse(row.entry_json) as Record<string, unknown>;
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
  const row = executeSqliteQueryTakeFirstSync<DeliveryQueueEntryRow>(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .select(["entry_json"])
      .where("queue_name", "=", QUEUE_NAME)
      .where("id", "=", id)
      .where("status", "=", "pending"),
  );
  return parseEntry(row, id);
}

export function readFailedQueuedEntry(tmpDir: string, id: string): Record<string, unknown> | null {
  const stateDatabase = openOpenClawStateDatabase(databaseOptions(tmpDir));
  const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
  const row = executeSqliteQueryTakeFirstSync<DeliveryQueueEntryRow>(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .select(["entry_json"])
      .where("queue_name", "=", QUEUE_NAME)
      .where("id", "=", id)
      .where("status", "=", "failed"),
  );
  return row ? (JSON.parse(row.entry_json) as Record<string, unknown>) : null;
}

export function readPendingQueuedEntries(tmpDir: string): Record<string, unknown>[] {
  const stateDatabase = openOpenClawStateDatabase(databaseOptions(tmpDir));
  const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
  return executeSqliteQuerySync<DeliveryQueueEntryRow>(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .select(["entry_json"])
      .where("queue_name", "=", QUEUE_NAME)
      .where("status", "=", "pending")
      .orderBy("enqueued_at", "asc")
      .orderBy("id", "asc"),
  ).rows.map((row) => JSON.parse(row.entry_json) as Record<string, unknown>);
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
