import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { inspectSqliteSchemaHeader } from "./sqlite-snapshot-source.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
import { acquireStateDatabaseHandleExclusion } from "./state-database-coordinator.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup();
  }),
);

function expectSourceExcluded(pathname: string) {
  let exclusion: ReturnType<typeof acquireStateDatabaseHandleExclusion> | undefined;
  try {
    expect(() => {
      exclusion = acquireStateDatabaseHandleExclusion({ databasePath: pathname, busyTimeoutMs: 0 });
    }).toThrow(/state-handles/);
  } finally {
    exclusion?.release();
  }
}

describe("schema-header native reader lifetime", () => {
  it("preserves the parent's rollback writer lock and excludes its uncommitted metadata", async () => {
    const root = dirs.make("sqlite-header-parent-lock-");
    const pathname = path.join(root, "source.sqlite");
    const writer = new (requireNodeSqlite().DatabaseSync)(pathname);
    writer.exec(
      "CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, app_version TEXT); INSERT INTO schema_meta VALUES('primary','committed'); PRAGMA user_version=7;",
    );
    writer.exec(
      "BEGIN IMMEDIATE; PRAGMA user_version=8; UPDATE schema_meta SET app_version='uncommitted';",
    );
    try {
      expect(await inspectSqliteSchemaHeader(pathname)).toEqual({
        userVersion: 7,
        writerAppVersion: "committed",
      });
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
          pathname,
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

  it.skipIf(process.platform === "win32")(
    "recovers a hot rollback journal only in its private snapshot",
    async () => {
      const root = dirs.make("sqlite-header-hot-journal-");
      const pathname = path.join(root, "source.sqlite");
      const database = new (requireNodeSqlite().DatabaseSync)(pathname);
      database.exec(`
      CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, app_version TEXT);
      INSERT INTO schema_meta VALUES('primary','committed');
      PRAGMA user_version=7;
      CREATE TABLE payload(data BLOB);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<32)
      INSERT INTO payload SELECT zeroblob(8192) FROM n;
    `);
      database.close();
      const crashed = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA synchronous=FULL; PRAGMA cache_size=2; PRAGMA cache_spill=ON; BEGIN IMMEDIATE; PRAGMA user_version=8; UPDATE schema_meta SET app_version='uncommitted'; UPDATE payload SET data=zeroblob(16384);");
      process.kill(process.pid, 'SIGKILL');
    `,
          pathname,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
      const before = [pathname, pathname + "-journal"].map((file) => fs.readFileSync(file));
      const cacheRoot = dirs.make("sqlite-header-journal-cache-");
      vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
      expect(await inspectSqliteSchemaHeader(pathname)).toEqual({
        userVersion: 7,
        writerAppVersion: "committed",
      });
      expect([pathname, pathname + "-journal"].map((file) => fs.readFileSync(file))).toEqual(
        before,
      );
      expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
    },
  );
  it.each([false, true])(
    "reads an inactive WAL family without changing data (SHM=%s)",
    async (includeShm) => {
      const root = dirs.make("sqlite-header-wal-only-");
      const pathname = path.join(root, "source.sqlite");
      const writerPath = path.join(dirs.make("sqlite-header-wal-writer-"), "writer.sqlite");
      const writer = new (requireNodeSqlite().DatabaseSync)(writerPath);
      try {
        writer.exec(
          "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, app_version TEXT); INSERT INTO schema_meta VALUES('primary','from-wal'); PRAGMA user_version=9;",
        );
        fs.copyFileSync(writerPath, pathname);
        fs.copyFileSync(writerPath + "-wal", pathname + "-wal");
        if (includeShm) {
          fs.copyFileSync(writerPath + "-shm", pathname + "-shm");
        }
      } finally {
        writer.close();
      }
      const before = [pathname, pathname + "-wal"].map((file) => fs.readFileSync(file));
      expect(await inspectSqliteSchemaHeader(pathname)).toEqual({
        userVersion: 9,
        writerAppVersion: "from-wal",
      });
      // Complete quiescent families keep the existing native SHM coordination;
      // an absent SHM must not be created beside the source.
      expect(fs.readdirSync(root).toSorted()).toEqual(
        [
          "source.sqlite",
          "source.sqlite-wal",
          ...(includeShm ? ["source.sqlite-shm"] : []),
        ].toSorted(),
      );
      expect([pathname, pathname + "-wal"].map((file) => fs.readFileSync(file))).toEqual(before);
    },
  );

  it.each(["success", "read-failure", "close-failure", "cancel"] as const)(
    "keeps a consistent read and its child lease through native close: %s",
    async (outcome) => {
      const root = dirs.make("sqlite-header-lifetime-");
      const pathname = path.join(root, "source.sqlite");
      const cacheRoot = path.join(root, "cache");
      fs.mkdirSync(cacheRoot);
      const marker = (name: string) => path.join(root, name);
      const preload = marker("lifetime.cjs");
      const writer = new (requireNodeSqlite().DatabaseSync)(pathname);
      writer.exec(`
        PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, app_version TEXT);
        INSERT INTO schema_meta VALUES('primary','writer-7');
        PRAGMA user_version=7;
      `);
      // Faults and native pauses are installed in the actual child, not a
      // production injection seam. The parent never opens a diagnostic source FD.
      fs.writeFileSync(
        preload,
        `
        const fs = require('node:fs'), path = require('node:path');
        const { DatabaseSync } = require('node:sqlite');
        const root = ${JSON.stringify(root)}, source = ${JSON.stringify(pathname)};
        const outcome = ${JSON.stringify(outcome)};
        const isSource = db => {
          const location = db.location();
          return location && path.toNamespacedPath(path.resolve(location)) === path.toNamespacedPath(path.resolve(source));
        };
        const mark = name => fs.writeFileSync(path.join(root, name), 'ready');
        const exists = name => fs.existsSync(path.join(root, name));
        function pause(name) {
          mark(name);
          const deadline = Date.now() + 15000;
          while (!exists(name + '-release')) {
            if (Date.now() > deadline) throw new Error('test native pause expired: ' + name);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        const prepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function(sql) {
          const statement = prepare.call(this, sql);
          if (isSource(this) && sql === 'PRAGMA user_version') {
            const get = statement.get;
            statement.get = function(...args) {
              const row = get.apply(this, args);
              pause('read');
              if (outcome === 'read-failure') throw new Error('native read failure');
              return row;
            };
          }
          return statement;
        };
        const close = DatabaseSync.prototype.close;
        DatabaseSync.prototype.close = function() {
          if (isSource(this)) {
            pause('close');
            if (outcome === 'close-failure') {
              const keepAlive = setInterval(() => {
                if (exists('exit-release')) clearInterval(keepAlive);
              }, 10);
              mark('failed-close');
              throw new Error('native close failure');
            }
          }
          return close.call(this);
        };
      `,
      );
      for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
        vi.stubEnv(key, value);
      }
      vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
      const controller = new AbortController();
      const cancellation = new Error("header inspection cancelled");
      let settled = false;
      const operation = inspectSqliteSchemaHeader(pathname, { signal: controller.signal });
      void operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await vi.waitFor(() => expect(fs.existsSync(marker("read"))).toBe(true), {
          timeout: 10_000,
        });
        expectSourceExcluded(pathname);
        // This newer pair commits between the child's two metadata queries.
        writer.exec(
          "BEGIN IMMEDIATE; PRAGMA user_version=8; UPDATE schema_meta SET app_version='writer-8'; COMMIT;",
        );
        fs.writeFileSync(marker("read-release"), "resume");
        await vi.waitFor(() => expect(fs.existsSync(marker("close"))).toBe(true), {
          timeout: 10_000,
        });
        expect(settled).toBe(false);
        expectSourceExcluded(pathname);
        if (outcome === "cancel") {
          controller.abort(cancellation);
          await expect(operation).rejects.toBe(cancellation);
        } else {
          fs.writeFileSync(marker("close-release"), "resume");
          if (outcome === "close-failure") {
            await vi.waitFor(() => expect(fs.existsSync(marker("failed-close"))).toBe(true));
            expect(settled).toBe(false);
            expectSourceExcluded(pathname);
            fs.writeFileSync(marker("exit-release"), "resume");
            await expect(operation).rejects.toThrow("native close failure");
          } else if (outcome === "read-failure") {
            await expect(operation).rejects.toThrow("native read failure");
          } else {
            await expect(operation).resolves.toEqual({
              userVersion: 7,
              writerAppVersion: "writer-7",
            });
          }
        }
        acquireStateDatabaseHandleExclusion({ databasePath: pathname, busyTimeoutMs: 0 }).release();
        expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
        expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
      } finally {
        controller.abort(cancellation);
        await Promise.allSettled([operation]);
        writer.close();
      }
    },
    30_000,
  );
});
