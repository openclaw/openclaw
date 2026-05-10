import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import type { InternalHookEvent } from "../../internal-hook-types.js";
import commandLogger from "./handler.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

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
    const rows = database.db
      .prepare(
        "SELECT timestamp_ms, action, session_key, sender_id, source, entry_json FROM command_log_entries",
      )
      .all() as Array<{
      timestamp_ms: number;
      action: string;
      session_key: string;
      sender_id: string;
      source: string;
      entry_json: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      timestamp_ms: Date.parse("2026-01-02T03:04:05.000Z"),
      action: "new",
      session_key: "agent:main:dm:user",
      sender_id: "user-123",
      source: "telegram",
    });
    expect(JSON.parse(rows[0]!.entry_json)).toEqual({
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
    const row = database.db.prepare("SELECT COUNT(*) AS count FROM command_log_entries").get() as {
      count: number;
    };
    expect(row.count).toBe(0);
  });
});
