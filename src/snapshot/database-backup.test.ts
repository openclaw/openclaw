import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSqliteShmPosixLocks } from "../infra/sqlite-posix-locks.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readBackupEngine, runOfflineDatabaseBackup } from "./database-backup.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it.each(["sqlite", "postgres"] as const)(
  "reads a live %s engine without allocating a database copy",
  async (engine) => {
    const root = directories.make("backup-engine-");
    const source = path.join(root, "source.sqlite");
    using writer = openNodeSqliteDatabase(source);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(value TEXT)");
    if (engine === "postgres") {
      writer.exec(`CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT);
        INSERT INTO openclaw_engine_anchor VALUES ('store-1', 'postgres', 'retained_store')`);
    }
    // Engine identity must not need capacity in the private snapshot cache.
    const unavailableCache = path.join(root, "cache-is-a-file");
    await fs.writeFile(unavailableCache, "occupied");
    vi.stubEnv("XDG_CACHE_HOME", unavailableCache);
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "0");
    const before = await Promise.all([fs.readFile(source), fs.readFile(`${source}-wal`)]);
    writer.exec("BEGIN IMMEDIATE; INSERT INTO evidence VALUES ('uncommitted')");
    const locks = () =>
      process.platform === "linux" || process.platform === "darwin"
        ? readSqliteShmPosixLocks(`${source}-shm`)
        : undefined;
    const held = locks();
    try {
      if (held) {
        expect(held.length).toBeGreaterThan(0);
      }
      expect(readBackupEngine(source)).toEqual(
        engine === "sqlite"
          ? { engine }
          : { engine, storeId: "store-1", namespace: "retained_store" },
      );
      expect(locks()).toEqual(held);
      expect(await Promise.all([fs.readFile(source), fs.readFile(`${source}-wal`)])).toEqual(
        before,
      );
    } finally {
      writer.exec("ROLLBACK");
    }
  },
);

it.each(["hot-journal", "missing-shm"])(
  "reads the committed anchor through private %s recovery without changing source bytes",
  async (recovery) => {
    const root = directories.make("backup-engine-recovery-");
    const source = path.join(root, "source.sqlite");
    {
      using db = openNodeSqliteDatabase(source);
      db.exec(`CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT);
        INSERT INTO openclaw_engine_anchor VALUES ('store-1', 'postgres', 'committed_store')`);
    }
    if (recovery === "hot-journal") {
      createHotSqliteRollbackJournal({
        path: source,
        mutationSql: "UPDATE openclaw_engine_anchor SET schema='uncommitted_store'",
      });
    } else {
      using writer = openNodeSqliteDatabase(path.join(root, "writer.sqlite"));
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(value)");
      writer.exec(`CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT);
        INSERT INTO openclaw_engine_anchor VALUES ('store-1', 'postgres', 'committed_store')`);
      await fs.copyFile(path.join(root, "writer.sqlite"), source);
      await fs.copyFile(path.join(root, "writer.sqlite-wal"), `${source}-wal`);
    }
    const files = [source, `${source}-${recovery === "hot-journal" ? "journal" : "wal"}`];
    const before = await Promise.all(files.map((file) => fs.readFile(file)));
    expect(readBackupEngine(source)).toEqual({
      engine: "postgres",
      storeId: "store-1",
      namespace: "committed_store",
    });
    expect(await Promise.all(files.map((file) => fs.readFile(file)))).toEqual(before);
    await expect(fs.stat(`${source}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["empty", "duplicate", "invalid-namespace", "unreadable"])(
  "refuses an %s engine source",
  async (kind) => {
    const source = path.join(directories.make("backup-engine-refusal-"), "source.sqlite");
    if (kind === "unreadable") {
      await fs.writeFile(source, "not a SQLite database");
    } else {
      using db = openNodeSqliteDatabase(source);
      db.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
      if (kind !== "empty") {
        db.prepare("INSERT INTO openclaw_engine_anchor VALUES ('store-1', 'postgres', ?)").run(
          kind === "invalid-namespace" ? "invalid-schema" : "valid_schema",
        );
        if (kind === "duplicate") {
          db.exec("INSERT INTO openclaw_engine_anchor SELECT * FROM openclaw_engine_anchor");
        }
      }
    }
    expect(() => readBackupEngine(source)).toThrow(
      kind === "unreadable" ? /not a database/ : /Invalid PostgreSQL anchor/,
    );
  },
);

describe("offline database backup admission", () => {
  it.each([false, true])(
    "rejects invalid recovery config before dispatch (archived: %s)",
    async (archived) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          database: {
            engine: "postgres",
            postgres: { connection: "postgresql://127.0.0.1:1/unused" },
          },
          gateway: { port: -1 },
        });
        let configPath: string | undefined;
        if (archived) {
          configPath = state.path("recovered-config.json");
          await fs.copyFile(state.configPath, configPath);
          await state.writeConfig({ database: { engine: "sqlite" } });
        }
        const target = state.path("backup-dispatched");
        await expect(
          runOfflineDatabaseBackup(
            target,
            async () => {
              await fs.writeFile(target, "dispatched");
            },
            configPath ? { configPath } : undefined,
          ),
        ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
        await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});
