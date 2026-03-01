import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock state-db and state-db-migrations before importing migration module
vi.mock("./state-db.js", () => {
  let mockPool: unknown = null;
  return {
    getStateDbPool: () => mockPool,
    hasStateDbConfigured: () => Boolean(mockPool),
    resolveStateDbUrl: () => (mockPool ? "postgres://mock" : null),
    __setMockPool: (pool: unknown) => {
      mockPool = pool;
    },
  };
});

vi.mock("./state-db-migrations.js", () => ({
  applyStateDbMigrations: vi.fn().mockResolvedValue(undefined),
}));

// Mock resolveStateDir to return our temp directory
let mockStateDir = "/tmp/test-state";
vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => mockStateDir,
}));

describe("migrate-datastore", () => {
  let tmpDir: string;
  let queries: Array<{ text: string; values?: unknown[] }>;
  let insertedRows: Map<string, unknown>;
  let mockPool: { query: ReturnType<typeof vi.fn> };
  let __setMockPool: (pool: unknown) => void;

  let migrateFilesystemToDatabase: typeof import("./migrate-datastore.js").migrateFilesystemToDatabase;
  let migrateDatabaseToFilesystem: typeof import("./migrate-datastore.js").migrateDatabaseToFilesystem;
  let runDatastoreMigrationIfNeeded: typeof import("./migrate-datastore.js").runDatastoreMigrationIfNeeded;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "migrate-ds-test-"));
    mockStateDir = tmpDir;
    queries = [];
    insertedRows = new Map();

    mockPool = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        // Simulate INSERT ... ON CONFLICT DO NOTHING
        if (typeof text === "string" && text.includes("insert into openclaw_kv")) {
          const key = values?.[0] as string;
          const data = values?.[1];
          if (!insertedRows.has(key)) {
            insertedRows.set(key, data);
          }
          return { rows: [], rowCount: 1 };
        }
        // Simulate SELECT for sentinel check
        if (typeof text === "string" && text.includes("select key from openclaw_kv")) {
          const key = values?.[0] as string;
          if (insertedRows.has(key)) {
            return { rows: [{ key }] };
          }
          return { rows: [] };
        }
        // Simulate SELECT all for database→filesystem
        if (typeof text === "string" && text.includes("select key, data from openclaw_kv")) {
          const rows = [...insertedRows.entries()]
            .filter(([k]) => !k.startsWith("_migration/"))
            .map(([key, data]) => ({ key, data }));
          return { rows };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const stateDb = await import("./state-db.js");
    __setMockPool = (stateDb as Record<string, unknown>).__setMockPool as (pool: unknown) => void;
    __setMockPool(mockPool);

    const mod = await import("./migrate-datastore.js");
    migrateFilesystemToDatabase = mod.migrateFilesystemToDatabase;
    migrateDatabaseToFilesystem = mod.migrateDatabaseToFilesystem;
    runDatastoreMigrationIfNeeded = mod.runDatastoreMigrationIfNeeded;
  });

  afterEach(() => {
    __setMockPool(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // migrateFilesystemToDatabase
  // -----------------------------------------------------------------------

  describe("migrateFilesystemToDatabase", () => {
    it("imports JSON files from the state directory", async () => {
      // Create some JSON files in the temp dir
      const credDir = path.join(tmpDir, "credentials");
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(path.join(credDir, "auth.json"), JSON.stringify({ token: "abc" }));
      fs.writeFileSync(path.join(tmpDir, "agents.json"), JSON.stringify({ list: [1, 2] }));

      const count = await migrateFilesystemToDatabase(mockPool as never, tmpDir);

      expect(count).toBe(2);
      // Sentinel row should be written
      expect(insertedRows.has("_migration/fs-to-db")).toBe(true);
      // Both data files should be inserted
      const insertQueries = queries.filter(
        (q) =>
          q.text.includes("insert into openclaw_kv") &&
          !q.values?.[0]?.toString().startsWith("_migration/"),
      );
      expect(insertQueries.length).toBe(2);
    });

    it("imports JSON files from nested state directories but skips excluded dirs", async () => {
      // State subdirectory — should be imported
      fs.mkdirSync(path.join(tmpDir, "cron"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "cron", "jobs.json"), JSON.stringify({ version: 1 }));
      fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify({ version: 1 }));
      fs.writeFileSync(path.join(tmpDir, "valid.json"), JSON.stringify({ ok: true }));

      // Excluded directories — should NOT be imported
      fs.mkdirSync(path.join(tmpDir, "workspace"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "workspace", "project.json"),
        JSON.stringify({ user: true }),
      );
      fs.mkdirSync(path.join(tmpDir, "workspace-bot2"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "workspace-bot2", "data.json"),
        JSON.stringify({ user: true }),
      );
      fs.mkdirSync(path.join(tmpDir, "media"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "media", "meta.json"), JSON.stringify({ type: "image" }));

      // Excluded file types
      fs.writeFileSync(path.join(tmpDir, "state.json.bak"), JSON.stringify({ backup: true }));

      const count = await migrateFilesystemToDatabase(mockPool as never, tmpDir);

      // Only the 3 state files should be imported
      expect(count).toBe(3);
    });

    it("returns 0 when state directory does not exist", async () => {
      const count = await migrateFilesystemToDatabase(mockPool as never, "/nonexistent/path");
      expect(count).toBe(0);
    });

    it("returns 0 when state directory is empty", async () => {
      const emptyDir = fs.mkdtempSync(path.join("/tmp", "empty-"));
      try {
        const count = await migrateFilesystemToDatabase(mockPool as never, emptyDir);
        expect(count).toBe(0);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it("skips corrupt JSON files with a warning", async () => {
      fs.writeFileSync(path.join(tmpDir, "corrupt.json"), "not valid json {{{");
      fs.writeFileSync(path.join(tmpDir, "valid.json"), JSON.stringify({ ok: true }));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const count = await migrateFilesystemToDatabase(mockPool as never, tmpDir);
      warnSpy.mockRestore();

      // Only the valid file should be imported
      expect(count).toBe(1);
      // Sentinel should NOT be written — corrupt file counts as a failure,
      // allowing retry on next startup.
      expect(insertedRows.has("_migration/fs-to-db")).toBe(false);
    });

    it("uses ON CONFLICT DO NOTHING so existing DB rows are preserved", async () => {
      const filePath = path.join(tmpDir, "existing.json");
      fs.writeFileSync(filePath, JSON.stringify({ overwritten: true }));

      // Compute the key normalizeKey will produce for this file path
      const pgMod = await import("./datastore-pg.js");
      const expectedKey = pgMod.normalizeKey(filePath);

      // Pre-populate the mock DB with the same key
      insertedRows.set(expectedKey, { original: true });

      await migrateFilesystemToDatabase(mockPool as never, tmpDir);

      // The original DB value should be preserved (ON CONFLICT DO NOTHING)
      expect(insertedRows.get(expectedKey)).toEqual({ original: true });
    });
  });

  // -----------------------------------------------------------------------
  // migrateDatabaseToFilesystem
  // -----------------------------------------------------------------------

  describe("migrateDatabaseToFilesystem", () => {
    it("writes DB rows as JSON files on the filesystem", async () => {
      insertedRows.set(".openclaw/credentials/auth.json", { token: "xyz" });
      insertedRows.set(".openclaw/agents/agent1.json", { name: "bot" });

      const count = await migrateDatabaseToFilesystem(mockPool as never, tmpDir);

      expect(count).toBe(2);
      // Verify the marker file was created
      const markerPath = path.join(tmpDir, ".migrated-from-db");
      expect(fs.existsSync(markerPath)).toBe(true);
    });

    it("skips files that already exist on disk", async () => {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      const existingFile = path.join(home, ".openclaw", "test-migrate-skip.json");
      insertedRows.set(".openclaw/test-migrate-skip.json", { fromDb: true });

      // Pre-create the file
      const dir = path.dirname(existingFile);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(existingFile, JSON.stringify({ existing: true }));

      try {
        const count = await migrateDatabaseToFilesystem(mockPool as never, tmpDir);

        // File should not have been overwritten
        const content = JSON.parse(fs.readFileSync(existingFile, "utf-8"));
        expect(content).toEqual({ existing: true });
        expect(count).toBe(0);
      } finally {
        fs.unlinkSync(existingFile);
      }
    });

    it("excludes sentinel keys from export", async () => {
      insertedRows.set("_migration/fs-to-db", { migratedAt: "2026-03-01" });
      insertedRows.set(".openclaw/real-data.json", { real: true });

      const count = await migrateDatabaseToFilesystem(mockPool as never, tmpDir);

      // Only the real data key should be written
      expect(count).toBe(1);
    });

    it("returns 0 when DB is empty", async () => {
      const count = await migrateDatabaseToFilesystem(mockPool as never, tmpDir);
      expect(count).toBe(0);
      // Marker file should NOT be written for empty DB
    });

    it("writes marker file after successful migration", async () => {
      insertedRows.set(".openclaw/some-data.json", { data: true });

      await migrateDatabaseToFilesystem(mockPool as never, tmpDir);

      const markerPath = path.join(tmpDir, ".migrated-from-db");
      expect(fs.existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
      expect(marker).toHaveProperty("migratedAt");
      expect(marker).toHaveProperty("count");
    });
  });

  // -----------------------------------------------------------------------
  // runDatastoreMigrationIfNeeded
  // -----------------------------------------------------------------------

  describe("runDatastoreMigrationIfNeeded", () => {
    it("fs-to-db: skips when sentinel exists in DB", async () => {
      insertedRows.set("_migration/fs-to-db", { migratedAt: "2026-03-01" });

      // Create a file that would normally be migrated
      fs.writeFileSync(
        path.join(tmpDir, "should-not-migrate.json"),
        JSON.stringify({ skip: true }),
      );

      await runDatastoreMigrationIfNeeded("filesystem-to-database");

      // No insert queries for user data should have been issued
      const dataInserts = queries.filter(
        (q) =>
          q.text.includes("insert into openclaw_kv") &&
          !q.values?.[0]?.toString().startsWith("_migration/"),
      );
      expect(dataInserts.length).toBe(0);
    });

    it("fs-to-db: runs migration when sentinel is absent", async () => {
      fs.writeFileSync(path.join(tmpDir, "data.json"), JSON.stringify({ migrate: true }));

      await runDatastoreMigrationIfNeeded("filesystem-to-database");

      // Should have inserted at least the data file + sentinel
      const inserts = queries.filter((q) => q.text.includes("insert into openclaw_kv"));
      expect(inserts.length).toBeGreaterThanOrEqual(2);
    });

    it("db-to-fs: skips when marker file exists", async () => {
      insertedRows.set(".openclaw/data.json", { restore: true });

      // Pre-create marker file
      fs.writeFileSync(path.join(tmpDir, ".migrated-from-db"), "{}");

      await runDatastoreMigrationIfNeeded("database-to-filesystem");

      // No SELECT query for data export should have been issued
      const selectAll = queries.filter((q) => q.text.includes("select key, data from openclaw_kv"));
      expect(selectAll.length).toBe(0);
    });

    it("db-to-fs: skips when no DB is configured", async () => {
      __setMockPool(null);

      await runDatastoreMigrationIfNeeded("database-to-filesystem");

      expect(queries.length).toBe(0);
    });
  });
});
