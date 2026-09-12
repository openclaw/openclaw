import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
import { acquireStateDatabaseHandleExclusion } from "./state-database-coordinator.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  }),
);

// Keep the fixture's writer open for native lock and failure probes.
function fixture() {
  const stateDir = fs.realpathSync(dirs.make("update-schema-lifetime-"));
  const file = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const writer = openNodeSqliteDatabase(file);
  writer.exec("PRAGMA user_version=3;");
  return { stateDir, file, writer };
}

it("preserves the parent agent writer lock and excludes its uncommitted migration", async () => {
  const { stateDir, file, writer } = fixture();
  writer.exec("BEGIN IMMEDIATE; PRAGMA user_version=4;");
  try {
    const versions = await readUpdateStateSchemaVersions({ stateDir, config: {} });
    expect(versions).toContainEqual({ path: file, userVersion: 3 });
    const competitor = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1]);
        try {
          db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK;');
          process.exitCode = 2;
        } catch(error) {
          if (error.errcode !== 5) throw error;
          process.stdout.write('writer refused');
        } finally { db.close(); }
      `,
        file,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(competitor.status, competitor.stderr).toBe(0);
    expect(competitor.stdout).toBe("writer refused");
    expect(writer.isTransaction).toBe(true);
  } finally {
    writer.exec("ROLLBACK;");
    writer.close();
  }
});

it.each(["timeout", "cancel", "read-failure", "close-failure"] as const)(
  "settles the schema worker before releasing ownership after %s",
  async (outcome) => {
    const { stateDir, file, writer } = fixture();
    const blocked = outcome === "timeout" || outcome === "cancel";
    if (blocked) {
      writer.exec("BEGIN EXCLUSIVE; PRAGMA user_version=4;");
    }
    const marker = path.join(stateDir, "native-read.json");
    const cache = path.join(stateDir, "cache");
    fs.mkdirSync(cache);
    fs.mkdirSync(path.join(cache, "openclaw"));
    const sentinel = path.join(cache, "unrelated.txt");
    fs.writeFileSync(sentinel, "preserved");
    const preload = path.join(stateDir, "native-fault.cjs");
    // Fault the real source connection inside the launched worker. A held
    // exclusive writer exercises SQLite's blocking read, not a sleeping stand-in.
    fs.writeFileSync(
      preload,
      `
      const fs = require('node:fs'), path = require('node:path');
      const { DatabaseSync } = require('node:sqlite');
      const source = ${JSON.stringify(file)}, marker = ${JSON.stringify(marker)};
      const outcome = ${JSON.stringify(outcome)};
      const isSource = db => db.location() && path.toNamespacedPath(db.location()) === path.toNamespacedPath(source);
      const prepare = DatabaseSync.prototype.prepare, close = DatabaseSync.prototype.close;
      DatabaseSync.prototype.prepare = function(sql) {
        if (isSource(this) && sql === 'PRAGMA user_version') {
          fs.writeFileSync(marker, JSON.stringify({pid:process.pid}));
          if (outcome === 'read-failure') throw new Error('native header read failed');
        }
        return prepare.call(this, sql);
      };
      DatabaseSync.prototype.close = function() {
        if (isSource(this) && outcome === 'close-failure') throw new Error('native header close failed');
        return close.call(this);
      };
    `,
    );
    const controller = new AbortController();
    const now = Date.now.bind(Date);
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
    const operation = readUpdateStateSchemaVersions({
      stateDir,
      config: {},
      signal: controller.signal,
      env: { ...process.env, ...sqliteWorkerPreloadEnv(preload), XDG_CACHE_HOME: cache },
    });
    const rejected = operation.catch((error: unknown) => error);
    try {
      if (blocked) {
        await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 10_000 });
        if (outcome === "cancel") {
          controller.abort();
        } else {
          elapsed = 400_000;
        }
      }
      const failure = await rejected;
      if (outcome === "cancel") {
        expect(failure).toMatchObject({ name: "AbortError" });
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toHaveProperty(
          "message",
          expect.stringMatching(
            outcome === "timeout" ? /made no progress/ : /native header (read|close) failed/,
          ),
        );
      }
      const { pid } = JSON.parse(fs.readFileSync(marker, "utf8")) as { pid: number };
      expect(() => process.kill(pid, 0)).toThrow();
      acquireStateDatabaseHandleExclusion({ databasePath: file, busyTimeoutMs: 0 }).release();
      expect(fs.readdirSync(cache)).toEqual(["openclaw", "unrelated.txt"]);
      expect(fs.readdirSync(path.join(cache, "openclaw"))).toEqual([]);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("preserved");
      expect(writer.prepare("PRAGMA user_version").get()).toEqual({
        user_version: blocked ? 4 : 3,
      });
    } finally {
      controller.abort();
      await Promise.allSettled([operation, rejected]);
      if (writer.isTransaction) {
        writer.exec("ROLLBACK;");
      }
      writer.close();
    }
  },
  15_000,
);
