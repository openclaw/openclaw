import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import type { InternalHookEvent } from "../../internal-hook-types.js";
import commandLogger from "./handler.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
type CommandLogTestDatabase = Pick<OpenClawStateKyselyDatabase, "command_log_entries">;

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-command-logger-"));
}

function createCommandEvent(overrides: Partial<InternalHookEvent> = {}): InternalHookEvent {
  return {
    type: "command",
    action: "new",
    sessionKey: "agent:main:dm:user",
    context: {
      senderId: "user-123",
      commandSource: "telegram",
    },
    timestamp: new Date("2026-01-02T03:04:05.000Z"),
    messages: [],
    ...overrides,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("command logger hook", () => {
  it("stores command events in the shared SQLite state database", async () => {
    process.env.OPENCLAW_STATE_DIR = createTempStateDir();

    await commandLogger(createCommandEvent());

    const database = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<CommandLogTestDatabase>(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("command_log_entries")
        .select(["timestamp_ms", "action", "session_key", "sender_id", "source", "entry_json"]),
    ).rows;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      timestamp_ms: Date.parse("2026-01-02T03:04:05.000Z"),
      action: "new",
      session_key: "agent:main:dm:user",
      sender_id: "user-123",
      source: "telegram",
    });
    expect(JSON.parse(rows[0].entry_json)).toEqual({
      timestamp: "2026-01-02T03:04:05.000Z",
      action: "new",
      sessionKey: "agent:main:dm:user",
      senderId: "user-123",
      source: "telegram",
    });
    expect(fs.existsSync(path.join(process.env.OPENCLAW_STATE_DIR, "logs", "commands.log"))).toBe(
      false,
    );
  });

  it("ignores non-command events", async () => {
    process.env.OPENCLAW_STATE_DIR = createTempStateDir();

    await commandLogger(createCommandEvent({ type: "session", action: "compact" }));

    const database = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<CommandLogTestDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("command_log_entries").select((eb) => eb.fn.countAll<number>().as("count")),
    );
    expect(row?.count).toBe(0);
  });
});
