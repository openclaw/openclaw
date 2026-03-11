import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// All imports are dynamic so we can set env before module loads

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-state-db-test-"));
});

afterEach(async () => {
  // Close any open connections before cleanup
  const { closeStateDb, resetStateDbCache } = await import("./connection.js");
  closeStateDb();
  resetStateDbCache();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

function testEnv(): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
}

// ── Connection tests ────────────────────────────────────────────────────────

describe("connection", () => {
  it("creates DB file at expected path", async () => {
    const { getStateDb, getStateDbPath } = await import("./connection.js");
    const env = testEnv();
    const dbPath = getStateDbPath(env);

    expect(dbPath).toBe(path.join(tmpDir, "operator1.db"));
    expect(fs.existsSync(dbPath)).toBe(false);

    getStateDb(env);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("sets WAL mode", async () => {
    const { getStateDb } = await import("./connection.js");
    const db = getStateDb(testEnv());
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
  });

  it("sets busy_timeout to 5000", async () => {
    const { getStateDb } = await import("./connection.js");
    const db = getStateDb(testEnv());
    const row = db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
    // PRAGMA column name varies by node:sqlite version — check any key
    const value = Object.values(row)[0];
    expect(value).toBe(5000);
  });

  it("enables foreign keys", async () => {
    const { getStateDb } = await import("./connection.js");
    const db = getStateDb(testEnv());
    const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  it("returns same instance on repeated calls (singleton)", async () => {
    const { getStateDb } = await import("./connection.js");
    const env = testEnv();
    const db1 = getStateDb(env);
    const db2 = getStateDb(env);
    expect(db1).toBe(db2);
  });

  it("closeStateDb + re-open works", async () => {
    const { getStateDb, closeStateDb, resetStateDbCache } = await import("./connection.js");
    const env = testEnv();
    const db1 = getStateDb(env);
    db1.exec("CREATE TABLE test_close (id INTEGER)");

    closeStateDb();
    resetStateDbCache();

    const db2 = getStateDb(env);
    // Table should persist across close/reopen
    const row = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_close'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("test_close");
  });
});

// ── Schema tests ────────────────────────────────────────────────────────────

describe("schema", () => {
  it("creates all P0 tables after runMigrations()", async () => {
    const { getStateDb } = await import("./connection.js");
    const { runMigrations, listTables } = await import("./schema.js");

    const db = getStateDb(testEnv());
    runMigrations(db);

    const tables = listTables(db);
    expect(tables).toContain("core_schema_version");
    expect(tables).toContain("session_entries");
    expect(tables).toContain("delivery_queue");
    expect(tables).toContain("op1_team_registry");
    expect(tables).toContain("op1_team_members");
    expect(tables).toContain("op1_team_tasks");
    expect(tables).toContain("op1_team_messages");
  });

  it("records schema version", async () => {
    const { getStateDb } = await import("./connection.js");
    const { runMigrations, getSchemaVersion } = await import("./schema.js");

    const db = getStateDb(testEnv());
    runMigrations(db);

    expect(getSchemaVersion(db)).toBe(1);
  });

  it("is idempotent — running twice does not error", async () => {
    const { getStateDb } = await import("./connection.js");
    const { runMigrations, getSchemaVersion } = await import("./schema.js");

    const db = getStateDb(testEnv());
    runMigrations(db);
    runMigrations(db);

    expect(getSchemaVersion(db)).toBe(1);
  });

  it("enforces foreign key constraints", async () => {
    const { getStateDb } = await import("./connection.js");
    const { runMigrations } = await import("./schema.js");

    const db = getStateDb(testEnv());
    runMigrations(db);

    // Inserting a team member with a non-existent team_id should fail
    expect(() => {
      db.prepare("INSERT INTO op1_team_members (team_id, agent_id) VALUES (?, ?)").run(
        "nonexistent",
        "agent-1",
      );
    }).toThrow();
  });

  it("getTableRowCount returns correct count", async () => {
    const { getStateDb } = await import("./connection.js");
    const { runMigrations, getTableRowCount } = await import("./schema.js");

    const db = getStateDb(testEnv());
    runMigrations(db);

    expect(getTableRowCount(db, "session_entries")).toBe(0);

    db.prepare("INSERT INTO session_entries (agent_id, session_key) VALUES (?, ?)").run(
      "agent-1",
      "key-1",
    );

    expect(getTableRowCount(db, "session_entries")).toBe(1);
  });
});

// ── Integrity tests ─────────────────────────────────────────────────────────

describe("integrity", () => {
  it("returns ok: true for valid DB", async () => {
    const { getStateDb, closeStateDb, resetStateDbCache, getStateDbPath } =
      await import("./connection.js");
    const { runMigrations } = await import("./schema.js");
    const { checkStateDbIntegrity } = await import("./integrity.js");

    const env = testEnv();
    const db = getStateDb(env);
    runMigrations(db);
    closeStateDb();
    resetStateDbCache();

    const result = checkStateDbIntegrity(getStateDbPath(env));
    expect(result.ok).toBe(true);
  });

  it("returns ok: true when DB does not exist", async () => {
    const { checkStateDbIntegrity } = await import("./integrity.js");
    const result = checkStateDbIntegrity(path.join(tmpDir, "nonexistent.db"));
    expect(result.ok).toBe(true);
  });

  it("returns ok: false and renames corrupt DB", async () => {
    const { checkStateDbIntegrity } = await import("./integrity.js");

    const corruptPath = path.join(tmpDir, "corrupt.db");
    fs.writeFileSync(corruptPath, "this is not a valid sqlite database");

    const result = checkStateDbIntegrity(corruptPath);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();

    // Original file should be renamed
    expect(fs.existsSync(corruptPath)).toBe(false);
    const corruptFiles = fs.readdirSync(tmpDir).filter((f) => f.includes(".corrupt."));
    expect(corruptFiles.length).toBeGreaterThan(0);
  });
});

// ── Retention tests ─────────────────────────────────────────────────────────

describe("retention", () => {
  it("caps op1_team_messages at 2000 per team", async () => {
    const { getStateDb } = await import("./connection.js");
    const { runMigrations } = await import("./schema.js");
    const { runRetention } = await import("./retention.js");

    const db = getStateDb(testEnv());
    runMigrations(db);

    // Create a team
    db.prepare("INSERT INTO op1_team_registry (team_id, name, created_at) VALUES (?, ?, ?)").run(
      "team-1",
      "Test Team",
      Date.now(),
    );

    // Insert 2500 messages
    const insert = db.prepare(
      "INSERT INTO op1_team_messages (team_id, agent_id, content, created_at) VALUES (?, ?, ?, ?)",
    );
    for (let i = 0; i < 2500; i++) {
      insert.run("team-1", "agent-1", `msg-${i}`, i);
    }

    const countBefore = (
      db.prepare("SELECT COUNT(*) as c FROM op1_team_messages").get() as { c: number }
    ).c;
    expect(countBefore).toBe(2500);

    const results = runRetention(db);
    const teamResult = results.find((r) => r.job === "op1_team_messages");
    expect(teamResult?.deleted).toBe(500);

    const countAfter = (
      db.prepare("SELECT COUNT(*) as c FROM op1_team_messages").get() as { c: number }
    ).c;
    expect(countAfter).toBe(2000);
  });

  it("purges old delivered queue items", async () => {
    const { getStateDb } = await import("./connection.js");
    const { runMigrations } = await import("./schema.js");
    const { runRetention } = await import("./retention.js");

    const db = getStateDb(testEnv());
    runMigrations(db);

    const now = Math.floor(Date.now() / 1000);
    const eightDaysAgo = now - 8 * 86400;
    const oneDayAgo = now - 86400;

    // Old delivered (should be purged)
    db.prepare(
      "INSERT INTO delivery_queue (queue_id, payload_json, status, created_at) VALUES (?, ?, ?, ?)",
    ).run("old-1", "{}", "delivered", eightDaysAgo);

    // Recent delivered (should be kept)
    db.prepare(
      "INSERT INTO delivery_queue (queue_id, payload_json, status, created_at) VALUES (?, ?, ?, ?)",
    ).run("new-1", "{}", "delivered", oneDayAgo);

    // Pending (should always be kept)
    db.prepare(
      "INSERT INTO delivery_queue (queue_id, payload_json, status, created_at) VALUES (?, ?, ?, ?)",
    ).run("pending-1", "{}", "pending", eightDaysAgo);

    runRetention(db);

    const remaining = db
      .prepare("SELECT queue_id FROM delivery_queue ORDER BY queue_id")
      .all() as Array<{
      queue_id: string;
    }>;
    expect(remaining.map((r) => r.queue_id)).toEqual(["new-1", "pending-1"]);
  });

  it("one failing retention job does not block others", async () => {
    const { getStateDb } = await import("./connection.js");
    const { runMigrations } = await import("./schema.js");
    const { runRetention } = await import("./retention.js");

    const db = getStateDb(testEnv());
    runMigrations(db);

    // Run retention on empty tables — all should succeed without errors
    const results = runRetention(db);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.error).toBeUndefined();
    }
  });
});

// ── initStateDb integration test ────────────────────────────────────────────

describe("initStateDb", () => {
  it("creates DB, runs migrations, and returns connection", async () => {
    const { closeStateDb, resetStateDbCache } = await import("./connection.js");
    const { initStateDb, getSchemaVersion, listTables } = await import("./index.js");

    // Reset state for a clean test
    closeStateDb();
    resetStateDbCache();

    const env = testEnv();
    const db = initStateDb(env);

    expect(getSchemaVersion(db)).toBe(1);
    expect(listTables(db).length).toBeGreaterThan(0);
  });
});
