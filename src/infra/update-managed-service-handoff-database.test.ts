import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import * as nodeSqlite from "./node-sqlite.js";
import * as tempRoot from "./tmp-openclaw-dir.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const openDatabase = nodeSqlite.openNodeSqliteDatabase;
let root: string;
let directory: string;
let databasePath: string;

beforeEach(() => {
  root = fs.realpathSync(dirs.make("update-authority-"));
  directory = path.join(root, "private-tmp");
  databasePath = path.join(directory, "managed-update-handoffs.sqlite");
  fs.mkdirSync(directory, { mode: 0o700 });
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(directory);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function snapshot() {
  const entries: {
    name: string;
    dev: number;
    ino: number;
    mode: number;
    content?: Buffer | string;
  }[] = [];
  const visit = (name: string) => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    entries.push({
      name,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      ...(stat.isSymbolicLink()
        ? { content: fs.readlinkSync(file) }
        : stat.isFile()
          ? { content: fs.readFileSync(file) }
          : {}),
    });
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(file).toSorted()) {
        visit(path.join(name, child));
      }
    }
  };
  visit(".");
  return entries;
}

async function authority() {
  return withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(root);
    return captureUpdateCommandExecutorAuthority(fence);
  });
}

function probeWriterAdmission(mode: "IMMEDIATE" | "EXCLUSIVE" = "IMMEDIATE") {
  const child = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "--eval",
      `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA busy_timeout=0");
        let outcome;
        try {
          db.exec("BEGIN " + process.argv[2]);
          outcome = { acquired: true };
          db.exec("ROLLBACK");
        } catch (error) {
          outcome = { acquired: false, errcode: error.errcode };
        } finally {
          db.close();
        }
        process.stdout.write(JSON.stringify(outcome));
      `,
      databasePath,
      mode,
    ],
    { encoding: "utf8", env: {}, timeout: 5_000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  return JSON.parse(child.stdout) as { acquired: boolean; errcode?: number };
}

const damage = [
  {
    name: "missing database",
    apply: () => fs.renameSync(databasePath, path.join(root, "retained.sqlite")),
  },
  {
    name: "missing parent",
    apply: () => fs.renameSync(directory, path.join(root, "retained-parent")),
  },
  {
    name: "byte-identical replacement database",
    apply: () => {
      const replacement = path.join(directory, "replacement.sqlite");
      fs.copyFileSync(databasePath, replacement);
      fs.chmodSync(replacement, 0o600);
      fs.renameSync(replacement, databasePath);
    },
  },
  {
    name: "replacement parent with the same database inode",
    apply: () => {
      const retained = path.join(root, "retained-parent");
      fs.renameSync(directory, retained);
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.renameSync(path.join(retained, path.basename(databasePath)), databasePath);
    },
  },
  {
    name: "corrupt database",
    apply: () => fs.writeFileSync(databasePath, "retained corrupt authority"),
  },
  {
    name: "empty database",
    apply: () => fs.truncateSync(databasePath, 0),
  },
  {
    name: "missing authority table",
    apply: () => {
      const db = new DatabaseSync(databasePath);
      try {
        db.exec("DROP TABLE managed_update_handoffs");
      } finally {
        db.close();
      }
    },
  },
  {
    name: "symlink database",
    apply: () => {
      const retained = path.join(root, "retained.sqlite");
      fs.renameSync(databasePath, retained);
      fs.symlinkSync(retained, databasePath);
    },
  },
  {
    name: "symlink parent",
    apply: () => {
      const retained = path.join(root, "retained-parent");
      fs.renameSync(directory, retained);
      fs.symlinkSync(retained, directory, "dir");
    },
  },
  {
    name: "multiply linked database",
    apply: () => fs.linkSync(databasePath, path.join(root, "linked.sqlite")),
  },
  {
    name: "different user",
    apply: () => {
      vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    },
  },
  {
    name: "unsafe database permissions",
    apply: () => fs.chmodSync(databasePath, 0o640),
  },
  {
    name: "unsafe parent permissions",
    apply: () => fs.chmodSync(directory, 0o750),
  },
];

describe.skipIf(process.platform === "win32")("existing update authority", () => {
  // Node CI shards do not provision Bun. BUN_BIN opts into runtime qualification;
  // a missing or incompatible selected binary must fail instead of skipping.
  it.runIf(Boolean(process.env.BUN_BIN))(
    "releases Bun snapshots with retained statements before later writers commit without GC",
    async () => {
      const existingIdentity = await authority();
      const store = createManagedHandoffLeaseStore({
        databasePath,
        serviceManagerEnv: resolveServiceManagerEnv(),
        existingIdentity,
      });
      const acquired = store.acquire(root, "bun-snapshot-owner", { kind: "update" });
      if (acquired.kind !== "acquired") {
        throw new Error("Bun snapshot fixture was not admitted");
      }
      const helperModule = new URL("./sqlite-existing-database.ts", import.meta.url).href;
      const authorityModule = new URL(
        "./update-managed-service-handoff-database.ts",
        import.meta.url,
      ).href;
      const child = spawnSync(
        process.env.BUN_BIN!,
        [
          "--no-install",
          "--eval",
          `
          import assert from "node:assert/strict";
          import { withExistingSqliteRollbackDatabase } from ${JSON.stringify(helperModule)};
          import { assertManagedUpdateLeaseDatabaseIdentity } from ${JSON.stringify(authorityModule)};
          assert.ok(process.versions.bun, "This regression requires the real Bun runtime");
          const authority = ${JSON.stringify(existingIdentity)};
          const retained = [];
          const options = {
            busyTimeoutMs: 0,
            assertIdentity: () => assertManagedUpdateLeaseDatabaseIdentity(authority),
            validate(database) {
              const statement = database.prepare(
                "SELECT owner FROM managed_update_handoffs WHERE install_root = ?"
              );
              retained.push({ database, statement });
              assert.equal(statement.get(authority.installKey).owner, "bun-snapshot-owner");
            },
          };
          let writes = 0;
          function write() {
            withExistingSqliteRollbackDatabase(
              authority.databasePath,
              { ...options, write: true },
              (database, transact) => transact(() => {
                const result = database.prepare(
                  "UPDATE managed_update_handoffs SET updated_at=updated_at+1 WHERE install_root = ?"
                ).run(authority.installKey);
                assert.equal(result.changes, 1);
              }),
            );
            writes++;
            assert.ok(retained.every(({ database }) => !database.isOpen));
          }
          write();
          withExistingSqliteRollbackDatabase(
            authority.databasePath,
            { ...options, write: false },
            (database) => assert.equal(database.isTransaction, true),
          );
          write();
          const failure = new Error("reader callback failed");
          assert.throws(
            () => withExistingSqliteRollbackDatabase(
              authority.databasePath,
              { ...options, write: false },
              () => { throw failure; },
            ),
            (error) => error === failure,
          );
          write();
          assert.throws(
            () => withExistingSqliteRollbackDatabase(
              authority.databasePath,
              {
                ...options,
                write: true,
                validate(database) {
                  options.validate(database);
                  throw failure;
                },
              },
              () => assert.fail("Invalid snapshot admitted a writer"),
            ),
            (error) => error === failure,
          );
          write();
          // Keep every native statement reachable through all later commits.
          // No forced GC or statement finalization may make this test pass.
          assert.ok(retained.every(({ statement }) => typeof statement.get === "function"));
          process.stdout.write(JSON.stringify({
            runtime: process.versions.bun,
            writes,
            retainedStatements: retained.length,
          }));
        `,
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOMEBREW_PREFIX: process.env.HOMEBREW_PREFIX,
            OPENCLAW_SQLITE_LIBRARY: process.env.OPENCLAW_SQLITE_LIBRARY,
          },
          encoding: "utf8",
          timeout: 15_000,
          killSignal: "SIGKILL",
        },
      );
      expect(
        child.error,
        "Bun runtime proof requires BUN_BIN to select a supported Bun executable",
      ).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        runtime: expect.any(String),
        writes: 4,
        retainedStatements: 7,
      });
      expect(store.read(root)).toMatchObject({
        kind: "current",
        lease: {
          owner: acquired.lease.owner,
          updatedAt: acquired.lease.updatedAt + 4,
        },
      });
    },
  );

  it.each(["update", "delete"] as const)(
    "keeps a real writer excluded across nested child and owner reads until %s commits",
    async (mutation) => {
      const existingAuthority = await authority();
      const store = createManagedHandoffLeaseStore({
        databasePath,
        serviceManagerEnv: resolveServiceManagerEnv(),
        existingIdentity: existingAuthority,
      });
      const admitted = store.acquire(root, "reserved-owner", { kind: "update" });
      if (admitted.kind !== "acquired") {
        throw new Error("Writer exclusion fixture was not admitted");
      }
      const withDatabase = createManagedHandoffLeaseDatabase(databasePath, existingAuthority);
      withDatabase(true, (db) => {
        expect(db.isTransaction).toBe(false);
        expect(probeWriterAdmission("EXCLUSIVE")).toEqual({ acquired: false, errcode: 5 });
        return withDatabase.transact(
          db,
          () => {
            expect(probeWriterAdmission()).toEqual({ acquired: false, errcode: 5 });
            // A second connection alone is safe. A raw open/read/close during
            // these owner reads must not discard the first connection's POSIX lock.
            const prefix = `${root}/.openclaw-update-child-`;
            const children = withDatabase(
              false,
              (reader) =>
                executeSqliteQuerySync(
                  reader,
                  leaseQueries(reader)
                    .selectFrom("managed_update_handoffs")
                    .select("owner")
                    .where("install_root", ">=", prefix)
                    .where("install_root", "<", prefix + "\uffff"),
                ).rows,
            );
            expect(children).toEqual([]);
            expect(store.current(admitted.lease)).toBe(true);
            expect(probeWriterAdmission()).toEqual({ acquired: false, errcode: 5 });
            if (mutation === "delete") {
              executeSqliteQuerySync(
                db,
                leaseQueries(db)
                  .deleteFrom("managed_update_handoffs")
                  .where("install_root", "=", root)
                  .where("owner", "=", admitted.lease.owner),
              );
            } else {
              executeSqliteQuerySync(
                db,
                leaseQueries(db)
                  .updateTable("managed_update_handoffs")
                  .set({ updated_at: admitted.lease.updatedAt + 1 })
                  .where("install_root", "=", root)
                  .where("owner", "=", admitted.lease.owner),
              );
            }
            expect(db.isTransaction).toBe(true);
            expect(probeWriterAdmission()).toEqual({ acquired: false, errcode: 5 });
          },
          {},
        );
      });
      expect(probeWriterAdmission("EXCLUSIVE")).toEqual({ acquired: true });
      const after = store.read(root);
      if (mutation === "delete") {
        expect(after).toEqual({ kind: "absent" });
      } else {
        expect(after).toMatchObject({
          kind: "current",
          lease: { owner: admitted.lease.owner, updatedAt: admitted.lease.updatedAt + 1 },
        });
      }
    },
  );

  it("keeps one installation's fence current during another installation's live write", async () => {
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      const existingIdentity = captureUpdateCommandExecutorAuthority(fence);
      const store = createManagedHandoffLeaseStore({
        databasePath,
        serviceManagerEnv: resolveServiceManagerEnv(),
        existingIdentity,
      });
      const original = store.read(root);
      if (original.kind !== "current") {
        throw new Error("First installation fixture was not admitted");
      }
      const otherRoot = path.join(root, "other-installation");
      fs.mkdirSync(otherRoot, { mode: 0o700 });
      const other = store.acquire(otherRoot, "other-owner", { kind: "update" });
      if (other.kind !== "acquired") {
        throw new Error("Second installation fixture was not admitted");
      }
      const child = spawn(
        process.execPath,
        [
          "--no-warnings",
          "--input-type=module",
          "--eval",
          `
            import { once } from "node:events";
            import { DatabaseSync } from "node:sqlite";
            const db = new DatabaseSync(process.argv[1]);
            db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
            const { changes } = db.prepare(
              "UPDATE managed_update_handoffs SET updated_at=updated_at+1 WHERE install_root=?"
            ).run(process.argv[2]);
            const resume = once(process, "message");
            process.send({ ready: true, changes, inTransaction: db.isTransaction });
            await resume;
            db.exec("COMMIT");
            db.close();
            process.disconnect();
          `,
          databasePath,
          otherRoot,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"], env: {} },
      );
      let stderr = "";
      const closed = once(child, "close");
      void closed.catch(() => undefined);
      try {
        if (!child.stderr) {
          throw new Error("Child fixture stderr pipe is missing");
        }
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        expect((await once(child, "message", { signal: AbortSignal.timeout(10_000) }))[0]).toEqual({
          ready: true,
          changes: 1,
          inTransaction: true,
        });
        expect(fs.statSync(databasePath + "-journal").size).toBeGreaterThan(512);
        // A live writer's RESERVED lock makes its journal non-hot. Readers
        // of another install key must still see their unchanged committed owner.
        expect(store.read(root)).toEqual(original);
        expect(store.owns(original.lease, "executor")).toBe(true);
        expect(() => fence.assertCurrent()).not.toThrow();
        child.send({ commit: true });
        expect(await closed).toEqual([0, null]);
        expect(stderr).toBe("");
        expect(store.read(root)).toEqual(original);
        expect(() => fence.assertCurrent()).not.toThrow();
        const updatedOther = store.read(otherRoot);
        expect(updatedOther).toMatchObject({
          kind: "current",
          lease: { owner: other.lease.owner, updatedAt: other.lease.updatedAt + 1 },
        });
        if (updatedOther.kind === "current") {
          expect(store.release(updatedOther.lease)).toBe(true);
        }
      } finally {
        await stopChildProcess(child, 5_000);
      }
    });
  });

  it("excludes a real writer until public release commits after its recorded child settles", async () => {
    const existingIdentity = await authority();
    const store = createManagedHandoffLeaseStore({
      databasePath,
      serviceManagerEnv: resolveServiceManagerEnv(),
      existingIdentity,
    });
    const parent = store.acquire(root, "parent-owner", { kind: "update" });
    const childKey = `${root}/.openclaw-update-child-${randomUUID()}`;
    const recordedChild = store.acquire(childKey, "child-owner", { kind: "update" });
    if (parent.kind !== "acquired" || recordedChild.kind !== "acquired") {
      throw new Error("Release child fixture was not admitted");
    }
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          process.once("message", () => process.disconnect());
          process.send({ ready: true });
        `,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"], env: {}, detached: true },
    );
    let stderr = "";
    const closed = once(child, "close", { signal: AbortSignal.timeout(10_000) });
    void closed.catch(() => undefined);
    try {
      if (!child.stderr) {
        throw new Error("Child fixture stderr pipe is missing");
      }
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      expect((await once(child, "message", { signal: AbortSignal.timeout(10_000) }))[0]).toEqual({
        ready: true,
      });
      if (child.pid === undefined) {
        throw new Error("Release child fixture has no process identity");
      }
      const boundChild = store.bind(recordedChild.lease, child.pid);
      if (!boundChild) {
        throw new Error("Release child fixture was not bound");
      }
      expect(store.release(parent.lease)).toBe(false);
      expect(store.release(boundChild)).toBe(false);
      expect(store.current(parent.lease)).toBe(true);
      expect(store.current(boundChild)).toBe(true);
      child.send({ exit: true });
      expect(await closed).toEqual([0, null]);
      expect(stderr).toBe("");
      expect(store.release(parent.lease)).toBe(false);
      expect(store.release(boundChild)).toBe(true);
      expect(store.read(childKey)).toEqual({ kind: "absent" });

      const boundaries: string[] = [];
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((location, options) => {
        const db = openDatabase(location, options);
        if (options?.readOnly || db.location() !== databasePath) {
          return db;
        }
        const prepare = db.prepare.bind(db);
        db.prepare = (sql) => {
          const statement = prepare(sql);
          const run = statement.run.bind(statement);
          statement.run = (...values) => {
            // Public release has completed its in-transaction child check when
            // its mutation reaches SQLite. Observe the real statement unchanged.
            expect(db.isTransaction).toBe(true);
            expect(values).toContain(parent.lease.key);
            expect(values).toContain(parent.lease.owner);
            boundaries.push("before-write");
            expect(probeWriterAdmission()).toEqual({ acquired: false, errcode: 5 });
            const result = Reflect.apply(run, statement, values);
            boundaries.push("after-write");
            expect(probeWriterAdmission()).toEqual({ acquired: false, errcode: 5 });
            return result;
          };
          return statement;
        };
        const exec = db.exec.bind(db);
        db.exec = (sql) => {
          if (sql === "COMMIT") {
            boundaries.push("before-commit");
            expect(db.isTransaction).toBe(true);
            expect(probeWriterAdmission()).toEqual({ acquired: false, errcode: 5 });
          }
          exec(sql);
          if (sql === "COMMIT") {
            boundaries.push("committed");
            expect(db.isTransaction).toBe(false);
          }
        };
        return db;
      });
      expect(store.release(parent.lease)).toBe(true);
      expect(boundaries).toEqual(["before-write", "after-write", "before-commit", "committed"]);
      expect(probeWriterAdmission()).toEqual({ acquired: true });
      expect(store.read(root)).toEqual({ kind: "absent" });
    } finally {
      await stopChildProcess(child, 5_000);
    }
  });

  describe.each(["admission", "release"] as const)("%s", (phase) => {
    it.each(damage)("preserves $name without repair", async ({ apply }) => {
      const existingAuthority = await authority();
      let before: ReturnType<typeof snapshot> | undefined;
      let assertNoRepairs: () => void = () => expect.fail("Authority was not revoked");
      const revoke = () => {
        apply();
        before = snapshot();
        const mkdir = vi.spyOn(fs, "mkdirSync");
        const chmod = vi.spyOn(fs, "chmodSync");
        assertNoRepairs = () => {
          for (const spy of [mkdir, chmod]) {
            expect(
              spy.mock.calls.filter(([file]) => String(file).startsWith(root + path.sep)),
            ).toEqual([]);
          }
        };
      };
      if (phase === "admission") {
        revoke();
      }
      let entered = false;
      await expect(
        withUpdateCommandExecutor(
          randomUUID(),
          async (executor) => {
            const fence = await executor.enter(root);
            entered = true;
            fence.assertCurrent();
            if (phase === "release") {
              revoke();
            }
          },
          { existingAuthority },
        ),
      ).rejects.toThrow();
      expect(entered).toBe(phase === "release");
      expect(before).toBeDefined();
      expect(snapshot()).toEqual(before);
      assertNoRepairs();
    });
  });

  it.each(["missing", "replaced"] as const)(
    "refuses a database %s immediately before a writable authority reopen",
    async (change) => {
      const existingAuthority = await authority();
      const retained = path.join(root, "retained.sqlite");
      let before: ReturnType<typeof snapshot> | undefined;
      let raced = false;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((location, options) => {
        if (options?.readOnly) {
          return openDatabase(location, options);
        }
        raced = true;
        fs.renameSync(databasePath, retained);
        if (change === "replaced") {
          fs.copyFileSync(retained, databasePath);
          fs.chmodSync(databasePath, 0o600);
        }
        before = snapshot();
        return openDatabase(location, options);
      });
      const operation = vi.fn();
      const withDatabase = createManagedHandoffLeaseDatabase(databasePath, existingAuthority);
      expect(() => withDatabase(true, operation)).toThrow();
      expect(raced).toBe(true);
      expect(operation).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    },
  );

  describe.each(["acquire", "release"] as const)("%s transaction", (operation) => {
    it.each(
      (["after-open", "after-begin", "before-commit"] as const).flatMap((boundary) =>
        (["database", "parent"] as const).map((target) => ({ boundary, target })),
      ),
    )("refuses a replaced $target at $boundary", async ({ boundary, target }) => {
      const existingAuthority = await authority();
      const store = createManagedHandoffLeaseStore({
        databasePath,
        serviceManagerEnv: resolveServiceManagerEnv(),
        existingIdentity: existingAuthority,
      });
      const admitted =
        operation === "release" ? store.acquire(root, "release-owner", { kind: "update" }) : null;
      if (admitted && admitted.kind !== "acquired") {
        throw new Error("Release fixture was not admitted");
      }
      const before = fs.readFileSync(databasePath);
      const retainedDatabase = path.join(root, "retained.sqlite");
      let raced = false;
      const replace = () => {
        if (raced) {
          return;
        }
        raced = true;
        if (target === "database") {
          fs.renameSync(databasePath, retainedDatabase);
          fs.copyFileSync(retainedDatabase, databasePath);
        } else {
          const retained = path.join(root, "retained-parent");
          fs.renameSync(directory, retained);
          fs.mkdirSync(directory, { mode: 0o700 });
          fs.renameSync(path.join(retained, path.basename(databasePath)), databasePath);
        }
      };
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((location, options) => {
        const db = openDatabase(location, options);
        if (options?.readOnly || db.location() !== databasePath) {
          return db;
        }
        if (boundary === "after-open") {
          replace();
        } else if (boundary === "after-begin") {
          const exec = db.exec.bind(db);
          db.exec = (sql) => {
            exec(sql);
            if (sql === "BEGIN IMMEDIATE") {
              replace();
            }
          };
        } else {
          const prepare = db.prepare.bind(db);
          db.prepare = (sql) => {
            const statement = prepare(sql);
            if (/^(insert into|delete from) "managed_update_handoffs"/u.test(sql)) {
              const run = statement.run.bind(statement);
              statement.run = (...values) => {
                const result = Reflect.apply(run, statement, values);
                replace();
                return result;
              };
            }
            return statement;
          };
        }
        return db;
      });
      expect(() =>
        admitted?.kind === "acquired"
          ? store.release(admitted.lease)
          : store.acquire(root, "next-owner", { kind: "update" }),
      ).toThrow();
      expect(raced).toBe(true);
      // Rollback owns its temporary journal, so compare database evidence only
      // after the native handle closes rather than freezing its in-flight journal.
      expect(fs.readFileSync(databasePath)).toEqual(before);
      if (target === "database") {
        expect(fs.readFileSync(retainedDatabase)).toEqual(before);
      }
    });
  });
});
