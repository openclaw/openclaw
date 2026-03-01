import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemDatastore } from "./datastore-fs.js";
import { resolveDatastoreType, setDatastore } from "./datastore.js";

// ---------------------------------------------------------------------------
// resolveDatastoreType
// ---------------------------------------------------------------------------

describe("resolveDatastoreType", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to fs when OPENCLAW_DATASTORE is not set", () => {
    delete process.env.OPENCLAW_DATASTORE;
    delete process.env.OPENCLAW_STATE_DB_URL;
    expect(resolveDatastoreType()).toBe("fs");
  });

  it("defaults to fs even when OPENCLAW_STATE_DB_URL is set but OPENCLAW_DATASTORE is not", () => {
    delete process.env.OPENCLAW_DATASTORE;
    process.env.OPENCLAW_STATE_DB_URL = "postgres://localhost/test";
    expect(resolveDatastoreType()).toBe("fs");
  });

  it("returns fs when OPENCLAW_DATASTORE is explicitly 'fs'", () => {
    process.env.OPENCLAW_DATASTORE = "fs";
    expect(resolveDatastoreType()).toBe("fs");
  });

  it("returns fs when OPENCLAW_DATASTORE is explicitly 'filesystem'", () => {
    process.env.OPENCLAW_DATASTORE = "filesystem";
    expect(resolveDatastoreType()).toBe("fs");
  });

  it("returns database when OPENCLAW_DATASTORE is 'database' and DB URL is set", () => {
    process.env.OPENCLAW_DATASTORE = "database";
    process.env.OPENCLAW_STATE_DB_URL = "postgres://localhost/test";
    expect(resolveDatastoreType()).toBe("database");
  });

  it("returns database when OPENCLAW_DATASTORE is 'db' and DB URL is set", () => {
    process.env.OPENCLAW_DATASTORE = "db";
    process.env.OPENCLAW_STATE_DB_URL = "postgres://localhost/test";
    expect(resolveDatastoreType()).toBe("database");
  });

  it("throws when OPENCLAW_DATASTORE is 'database' but OPENCLAW_STATE_DB_URL is not set", () => {
    process.env.OPENCLAW_DATASTORE = "database";
    delete process.env.OPENCLAW_STATE_DB_URL;
    expect(() => resolveDatastoreType()).toThrow(
      /OPENCLAW_DATASTORE is set to "database" but OPENCLAW_STATE_DB_URL is not configured/,
    );
  });

  it("throws for unknown OPENCLAW_DATASTORE values", () => {
    process.env.OPENCLAW_DATASTORE = "sqlite";
    expect(() => resolveDatastoreType()).toThrow(/Invalid OPENCLAW_DATASTORE value: "sqlite"/);
  });
});

// ---------------------------------------------------------------------------
// FilesystemDatastore — proves data goes to disk, not to a database
// ---------------------------------------------------------------------------

describe("FilesystemDatastore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "datastore-test-"));
    setDatastore(null);
  });

  afterEach(() => {
    setDatastore(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writeJson() persists JSON to a file on disk", () => {
    const ds = new FilesystemDatastore();
    const filePath = path.join(tmpDir, "test-store.json");
    const testData = { version: 1, items: ["a", "b", "c"] };

    ds.writeJson(filePath, testData);

    // Proof: the file exists on disk with the correct data
    const raw = fs.readFileSync(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual(testData);
  });

  it("readJson() returns data from the file on disk", () => {
    const ds = new FilesystemDatastore();
    const filePath = path.join(tmpDir, "sync-read.json");

    // Write directly to disk (simulating pre-existing data)
    fs.writeFileSync(filePath, JSON.stringify({ hello: "world" }), "utf-8");

    const result = ds.readJson(filePath);
    expect(result).toEqual({ hello: "world" });
  });

  it("readJson() returns null for non-existent keys", () => {
    const ds = new FilesystemDatastore();
    expect(ds.readJson(path.join(tmpDir, "does-not-exist.json"))).toBeNull();
  });

  it("writeJsonWithBackup() creates both the file and a .bak copy", () => {
    const ds = new FilesystemDatastore();
    const filePath = path.join(tmpDir, "backup-test.json");
    const testData = { version: 1, backupTest: true };

    ds.writeJsonWithBackup(filePath, testData);

    expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))).toEqual(testData);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf-8"))).toEqual(testData);
  });

  it("delete() removes the file from disk", () => {
    const ds = new FilesystemDatastore();
    const filePath = path.join(tmpDir, "delete-test.json");

    ds.writeJson(filePath, { temp: true });
    expect(fs.existsSync(filePath)).toBe(true);

    ds.delete(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("updateJsonWithLock() performs atomic read-modify-write on disk", async () => {
    const ds = new FilesystemDatastore();
    const filePath = path.join(tmpDir, "lock-test.json");

    ds.writeJson(filePath, { count: 0 });

    await ds.updateJsonWithLock(filePath, (current) => {
      const c = current as { count: number } | null;
      return { changed: true, result: { count: (c?.count ?? 0) + 1 } };
    });

    const result = ds.readJson(filePath);
    expect(result).toEqual({ count: 1 });
    // Proof: the file on disk also reflects the update
    expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))).toEqual({ count: 1 });
  });

  it("produces only filesystem artifacts — no database side effects", () => {
    const ds = new FilesystemDatastore();
    const filePath = path.join(tmpDir, "no-db.json");

    ds.writeJson(filePath, { isolated: true });

    // Proof: the only artifact is the file on disk
    const files = fs.readdirSync(tmpDir);
    expect(files).toEqual(["no-db.json"]);
  });
});

// ---------------------------------------------------------------------------
// PostgresDatastore — proves data goes to the database via SQL, not to disk
// ---------------------------------------------------------------------------

// Mock the pg module dependencies so we can test without a real database.
// We intercept `getStateDbPool` and `applyStateDbMigrations` at the module
// boundary, then verify the exact SQL queries the datastore issues.

vi.mock("./state-db.js", () => {
  let mockPool: unknown = null;
  return {
    getStateDbPool: () => mockPool,
    resolveStateDbUrl: (env?: Record<string, string | undefined>) => {
      const e = env ?? process.env;
      return e.OPENCLAW_STATE_DB_URL?.trim() || (mockPool ? "postgres://mock" : null);
    },
    hasStateDbConfigured: (env?: Record<string, string | undefined>) => {
      const e = env ?? process.env;
      return Boolean(e.OPENCLAW_STATE_DB_URL?.trim()) || Boolean(mockPool);
    },
    __setMockPool: (pool: unknown) => {
      mockPool = pool;
    },
  };
});

vi.mock("./state-db-migrations.js", () => ({
  applyStateDbMigrations: vi.fn().mockResolvedValue(undefined),
}));

describe("PostgresDatastore", () => {
  // Recorded queries from the mock pool, so we can assert exactly what SQL
  // the datastore sends to the database.
  let queries: Array<{ text: string; values?: unknown[] }>;
  let mockPool: {
    query: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  };

  // Dynamic import so the mocks are in place before the module loads.
  let PostgresDatastore: typeof import("./datastore-pg.js").PostgresDatastore;
  let __setMockPool: (pool: unknown) => void;

  beforeEach(async () => {
    queries = [];

    const mockClient = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (typeof text === "string" && text.includes("select data from")) {
          // Simulate SELECT ... FOR UPDATE returning no rows initially
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    mockPool = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (typeof text === "string" && text.includes("select key, data from")) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(async () => mockClient),
    };

    const stateDb = await import("./state-db.js");
    __setMockPool = (stateDb as Record<string, unknown>).__setMockPool as (pool: unknown) => void;
    __setMockPool(mockPool);

    const pgModule = await import("./datastore-pg.js");
    PostgresDatastore = pgModule.PostgresDatastore;
  });

  afterEach(() => {
    __setMockPool(null);
    setDatastore(null);
  });

  it("writeJson() issues an INSERT ... ON CONFLICT upsert to the database", async () => {
    const ds = new PostgresDatastore();
    setDatastore(ds);

    ds.writeJson("/home/user/.openclaw/state/test.json", { version: 1, data: "hello" });
    await ds._flushPendingWrites();

    // Proof: an INSERT query was sent to the pool
    const insertQuery = queries.find((q) => q.text.includes("insert into openclaw_kv"));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.values).toBeDefined();
    expect(insertQuery!.values![1]).toEqual({ version: 1, data: "hello" });
  });

  it("readJson() returns data from the in-memory write-through cache after write()", () => {
    const ds = new PostgresDatastore();
    setDatastore(ds);

    // Use a unique key so the module-level cache doesn't have stale data
    const uniqueKey = `/home/user/.openclaw/state/cache-test-${Date.now()}.json`;

    // Before write, cache is empty for this key
    expect(ds.readJson(uniqueKey)).toBeNull();

    ds.writeJson(uniqueKey, { cached: true });

    // After write, read returns from cache without any SELECT query
    const readCountBefore = queries.filter((q) => q.text.includes("select")).length;
    const result = ds.readJson(uniqueKey);
    const readCountAfter = queries.filter((q) => q.text.includes("select")).length;

    expect(result).toEqual({ cached: true });
    // Proof: no new SELECT was issued — read() is purely from cache
    expect(readCountAfter).toBe(readCountBefore);
  });

  it("writeJson() does NOT create any files on disk", () => {
    const ds = new PostgresDatastore();
    const tmpDir = fs.mkdtempSync(path.join("/tmp", "pg-no-fs-"));

    try {
      const key = path.join(tmpDir, "should-not-exist.json");
      ds.writeJson(key, { pgOnly: true });

      // Proof: the directory is still empty — no file was created
      const files = fs.readdirSync(tmpDir);
      expect(files).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("delete() issues a DELETE query to the database", async () => {
    const ds = new PostgresDatastore();

    ds.writeJson("/home/user/.openclaw/state/del.json", { temp: true });
    await ds._flushPendingWrites();
    queries = []; // reset

    ds.delete("/home/user/.openclaw/state/del.json");
    await ds._flushPendingWrites();

    const deleteQuery = queries.find((q) => q.text.includes("delete from openclaw_kv"));
    expect(deleteQuery).toBeDefined();

    // Cache is also cleared
    expect(ds.readJson("/home/user/.openclaw/state/del.json")).toBeNull();
  });

  it("updateJsonWithLock() acquires advisory lock and reads inside a transaction", async () => {
    const ds = new PostgresDatastore();

    await ds.updateJsonWithLock("/home/user/.openclaw/state/lock.json", (current) => {
      const c = current as { count: number } | null;
      return { changed: true, result: { count: (c?.count ?? 0) + 1 } };
    });

    // Proof: the transaction lifecycle was followed
    const queryTexts = queries.map((q) => q.text.trim());
    expect(queryTexts).toContain("begin");
    expect(queryTexts).toContain("commit");
    // Advisory lock acquired before the read — serializes even for missing rows
    expect(queryTexts.some((t) => t.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(queryTexts.some((t) => t.includes("select data from openclaw_kv"))).toBe(true);
    expect(queryTexts.some((t) => t.includes("insert into openclaw_kv"))).toBe(true);
  });

  it("preloadAll() populates the cache from the database", async () => {
    // Override the pool query to return rows from the "database"
    mockPool.query.mockImplementation(async (text: string) => {
      queries.push({ text });
      if (typeof text === "string" && text.includes("select key, data from openclaw_kv")) {
        return {
          rows: [
            { key: "/.openclaw/state/a.json", data: { name: "alpha" } },
            { key: "/.openclaw/state/b.json", data: { name: "beta" } },
          ],
        };
      }
      return { rows: [] };
    });

    const ds = new PostgresDatastore();

    // Before preload, cache is empty
    expect(ds.readJson("/.openclaw/state/a.json")).toBeNull();
    expect(ds.readJson("/.openclaw/state/b.json")).toBeNull();

    await ds.preloadAll();

    // After preload, cache has the data from the database
    expect(ds.readJson("/.openclaw/state/a.json")).toEqual({ name: "alpha" });
    expect(ds.readJson("/.openclaw/state/b.json")).toEqual({ name: "beta" });

    // Proof: a SELECT query was issued to fetch all rows
    const selectAll = queries.find(
      (q) => q.text.includes("select key, data from openclaw_kv") && !q.text.includes("where"),
    );
    expect(selectAll).toBeDefined();
  });

  it("writeJsonWithBackup() delegates to write() — issues INSERT, no filesystem backup", async () => {
    const ds = new PostgresDatastore();
    const tmpDir = fs.mkdtempSync(path.join("/tmp", "pg-no-bak-"));

    try {
      const key = path.join(tmpDir, "no-backup.json");
      ds.writeJsonWithBackup(key, { dbOnly: true });
      await ds._flushPendingWrites();

      // Proof: INSERT query was issued to the database
      const insertQuery = queries.find((q) => q.text.includes("insert into openclaw_kv"));
      expect(insertQuery).toBeDefined();

      // Proof: no files on disk — no .json, no .bak
      const files = fs.readdirSync(tmpDir);
      expect(files).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("normalizes keys by stripping the HOME prefix for portability", async () => {
    const ds = new PostgresDatastore();
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

    ds.writeJson(`${home}/.openclaw/state/portable.json`, { portable: true });
    await ds._flushPendingWrites();

    // The key stored in the DB should be relative (no home dir, no leading /)
    const insertQuery = queries.find((q) => q.text.includes("insert into openclaw_kv"));
    expect(insertQuery!.values![0]).toBe(".openclaw/state/portable.json");

    // read() with the full path still works (normalizes the same way)
    const result = ds.readJson(`${home}/.openclaw/state/portable.json`);
    expect(result).toEqual({ portable: true });
  });
});
