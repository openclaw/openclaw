import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  hasFollowupQueueEntries,
  loadFollowupQueueEntries,
  replaceFollowupQueueEntries,
} from "./followup-queue-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";

describe("followup-queue-sqlite", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-followup-sqlite-"));
    originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    closeOpenClawStateDatabaseForTest();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates followup_queue_entries on a fresh shared state database", () => {
    openOpenClawStateDatabase({ env: process.env });
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath, {
      readOnly: true,
    });
    try {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'followup_queue_entries'",
        )
        .get() as { name?: string } | undefined;
      expect(row?.name).toBe("followup_queue_entries");
    } finally {
      db.close();
    }
    expect(hasFollowupQueueEntries(tmpDir)).toBe(false);
  });

  it("round-trips queue entries through replace and load", () => {
    replaceFollowupQueueEntries({
      stateDir: tmpDir,
      entries: [
        [
          "agent:main:dm:sqlite-test",
          {
            items: [{ prompt: "stored", enqueuedAt: 1, run: { agentId: "main" } }],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });
    expect(hasFollowupQueueEntries(tmpDir)).toBe(true);
    const entries = loadFollowupQueueEntries(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("agent:main:dm:sqlite-test");
    const queueData = entries[0][1] as { items?: Array<{ prompt?: string }> };
    expect(queueData.items?.[0]?.prompt).toBe("stored");

    replaceFollowupQueueEntries({ stateDir: tmpDir, entries: [] });
    expect(hasFollowupQueueEntries(tmpDir)).toBe(false);
  });
});
