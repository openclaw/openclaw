import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MINION_SCHEMA_VERSION } from "./schema.js";
import { MinionStore } from "./store.js";

describe("minions schema", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minions-schema-"));
    dbPath = path.join(tmpDir, "queue.sqlite");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates tables and indices on first open", () => {
    const store = MinionStore.openAt(dbPath);
    try {
      const tables = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((row) => row.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "minion_jobs",
          "minion_inbox",
          "minion_attachments",
          "minion_meta",
        ]),
      );

      const indices = store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      const indexNames = indices.map((row) => row.name);
      expect(indexNames).toEqual(
        expect.arrayContaining([
          "idx_minion_jobs_claim",
          "idx_minion_jobs_stalled",
          "idx_minion_jobs_timeout",
          "idx_minion_jobs_delayed",
          "idx_minion_jobs_parent_status",
          "idx_minion_inbox_unread",
          "idx_minion_attachments_job",
          "uniq_minion_jobs_idempotency",
        ]),
      );
    } finally {
      store.close();
    }
  });

  it("records the schema version", () => {
    const store = MinionStore.openAt(dbPath);
    try {
      const row = store.db
        .prepare("SELECT value FROM minion_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      expect(row).toBeDefined();
      expect(Number.parseInt(row!.value, 10)).toBe(MINION_SCHEMA_VERSION);
    } finally {
      store.close();
    }
  });

  it("is idempotent on re-open", () => {
    MinionStore.openAt(dbPath).close();
    const store = MinionStore.openAt(dbPath);
    try {
      const row = store.db
        .prepare("SELECT value FROM minion_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      expect(row).toBeDefined();
      expect(Number.parseInt(row!.value, 10)).toBe(MINION_SCHEMA_VERSION);

      const count = store.db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
        .get() as { n: number | bigint };
      const n = typeof count.n === "bigint" ? Number(count.n) : count.n;
      expect(n).toBeGreaterThanOrEqual(4);
    } finally {
      store.close();
    }
  });

  it("enforces the status CHECK constraint", () => {
    const store = MinionStore.openAt(dbPath);
    try {
      const now = Date.now();
      expect(() => {
        store.db
          .prepare(
            "INSERT INTO minion_jobs (name, status, created_at, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run("bad", "not-a-status", now, now);
      }).toThrow(/CHECK constraint/i);
    } finally {
      store.close();
    }
  });

  it("enforces the parent_job_id self-reference CHECK", () => {
    const store = MinionStore.openAt(dbPath);
    try {
      const now = Date.now();
      const insert = store.db.prepare(
        "INSERT INTO minion_jobs (name, status, created_at, updated_at) VALUES (?, ?, ?, ?)",
      );
      const result = insert.run("root", "waiting", now, now);
      const rowid = typeof result.lastInsertRowid === "bigint"
        ? Number(result.lastInsertRowid)
        : result.lastInsertRowid;
      expect(() => {
        store.db
          .prepare("UPDATE minion_jobs SET parent_job_id = ? WHERE id = ?")
          .run(rowid, rowid);
      }).toThrow(/CHECK constraint/i);
    } finally {
      store.close();
    }
  });

  it("enforces the idempotency_key unique partial index (non-null)", () => {
    const store = MinionStore.openAt(dbPath);
    try {
      const now = Date.now();
      const stmt = store.db.prepare(
        "INSERT INTO minion_jobs (name, status, created_at, updated_at, idempotency_key) VALUES (?, ?, ?, ?, ?)",
      );
      stmt.run("a", "waiting", now, now, "same-key");
      expect(() => stmt.run("b", "waiting", now, now, "same-key")).toThrow(/UNIQUE/i);
    } finally {
      store.close();
    }
  });

  it("allows multiple null idempotency_key rows (null-permissive)", () => {
    const store = MinionStore.openAt(dbPath);
    try {
      const now = Date.now();
      const stmt = store.db.prepare(
        "INSERT INTO minion_jobs (name, status, created_at, updated_at, idempotency_key) VALUES (?, ?, ?, ?, ?)",
      );
      stmt.run("a", "waiting", now, now, null);
      stmt.run("b", "waiting", now, now, null);
      stmt.run("c", "waiting", now, now, null);
      const count = store.db
        .prepare("SELECT count(*) AS n FROM minion_jobs WHERE idempotency_key IS NULL")
        .get() as { n: number | bigint };
      const n = typeof count.n === "bigint" ? Number(count.n) : count.n;
      expect(n).toBe(3);
    } finally {
      store.close();
    }
  });

  it("WAL pragma is in effect after open", () => {
    const store = MinionStore.openAt(dbPath);
    try {
      const row = store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode.toLowerCase()).toBe("wal");
    } finally {
      store.close();
    }
  });
});
