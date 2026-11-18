import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { listDirectoryTreeStrictSync } from "./directory-walk.js";
import * as nodeSqlite from "./node-sqlite.js";
import { classifySqliteMutation } from "./sqlite-schema-mutation.js";
import * as tempRoot from "./tmp-openclaw-dir.js";
import {
  createManagedHandoffLeaseDatabase,
  type ManagedUpdateLeaseDatabaseIdentity,
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

afterEach(() => vi.restoreAllMocks());

function snapshot() {
  const names = [".", ...listDirectoryTreeStrictSync(root).map((entry) => entry.relativePath)];
  return names.map((name) => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    return Object.assign(
      { name, dev: stat.dev, ino: stat.ino, mode: stat.mode },
      stat.isSymbolicLink()
        ? { content: fs.readlinkSync(file) }
        : stat.isFile()
          ? { content: fs.readFileSync(file) }
          : {},
    );
  });
}

async function authority() {
  return withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(root);
    return captureUpdateCommandExecutorAuthority(fence);
  });
}

function storeFor(existingIdentity: ManagedUpdateLeaseDatabaseIdentity) {
  return createManagedHandoffLeaseStore({
    databasePath,
    serviceManagerEnv: resolveServiceManagerEnv(),
    existingIdentity,
  });
}

function acquire(store: ReturnType<typeof storeFor>, owner: string, key = root) {
  const result = store.acquire(key, owner, { kind: "update" });
  assert(result.kind === "acquired", `${owner} fixture was not admitted`);
  return result.lease;
}

function spawnNode(script: string, args: string[] = [], detached = false) {
  return spawn(
    process.execPath,
    ["--no-warnings", "--input-type=module", "--eval", script, ...args],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {},
      detached,
    },
  );
}

function observeWritableDatabase(observe: (db: DatabaseSync) => void) {
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((location, options) => {
    const db = openDatabase(location, options);
    if (!options?.readOnly && db.location() === databasePath) {
      observe(db);
    }
    return db;
  });
}

async function withChild(
  child: ChildProcess,
  signal: AbortSignal,
  run: (ready: unknown, finish: () => Promise<void>) => Promise<void>,
) {
  let stderr = "";
  const closed = once(child, "close");
  void closed.catch(() => undefined);
  try {
    assert(child.stderr, "Child fixture stderr pipe is missing");
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const [ready] = await withinTest(
      awaitGateBeforeSettlement(
        once(child, "message"),
        closed,
        "Child fixture exited before readiness",
      ),
      signal,
    );
    await run(ready, async () => {
      expect(await withinTest(closed, signal)).toEqual([0, null]);
      expect(stderr).toBe("");
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  }
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

function retain(file: string) {
  const retained = path.join(root, `retained-${path.basename(file)}`);
  fs.renameSync(file, retained);
  return retained;
}

function replaceParent() {
  const retained = retain(directory);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.renameSync(path.join(retained, path.basename(databasePath)), databasePath);
}

const damage: [name: string, apply: () => void][] = [
  ["missing database", () => retain(databasePath)],
  ["missing parent", () => retain(directory)],
  [
    "byte-identical replacement database",
    () => {
      const replacement = path.join(directory, "replacement.sqlite");
      fs.copyFileSync(databasePath, replacement);
      fs.chmodSync(replacement, 0o600);
      fs.renameSync(replacement, databasePath);
    },
  ],
  ["replacement parent with the same database inode", replaceParent],
  ["corrupt database", () => fs.writeFileSync(databasePath, "retained corrupt authority")],
  ["empty database", () => fs.truncateSync(databasePath, 0)],
  [
    "missing authority table",
    () => {
      using db = new DatabaseSync(databasePath);
      db.exec("DROP TABLE managed_update_handoffs");
    },
  ],
  ["symlink database", () => fs.symlinkSync(retain(databasePath), databasePath)],
  ["symlink parent", () => fs.symlinkSync(retain(directory), directory, "dir")],
  ["multiply linked database", () => fs.linkSync(databasePath, path.join(root, "linked.sqlite"))],
  ["different user", () => vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1)],
  ["unsafe database permissions", () => fs.chmodSync(databasePath, 0o640)],
  ["unsafe parent permissions", () => fs.chmodSync(directory, 0o750)],
];

describe.skipIf(process.platform === "win32")("existing update authority", () => {
  it("reopens an initialized writable handoff owner without repeating DDL", () => {
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
    withDatabase(true, (db) =>
      db
        .prepare(
          "INSERT INTO managed_update_handoffs (install_root,owner,payload_json,updated_at) VALUES (?,?,?,?)",
        )
        .run(root, "warm-owner", "{}", 1),
    );
    const sql = observeHostDataSql();
    try {
      withDatabase(true, (db) =>
        withDatabase.transact(
          db,
          () =>
            db
              .prepare("UPDATE managed_update_handoffs SET updated_at=2 WHERE install_root=?")
              .run(root),
          {},
        ),
      );
      expect(
        withDatabase(false, (db) =>
          db
            .prepare("SELECT owner, updated_at FROM managed_update_handoffs WHERE install_root=?")
            .all(root),
        ),
      ).toEqual([{ owner: "warm-owner", updated_at: 2 }]);
      expect(
        sql.queries.filter((query) => classifySqliteMutation(query, "batch").mainSchemaChange),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  // Node CI shards do not provision Bun. BUN_BIN opts into runtime qualification;
  // a missing or incompatible selected binary must fail instead of skipping.
  it.runIf(Boolean(process.env.BUN_BIN))(
    "releases Bun snapshots with retained statements before later writers commit without GC",
    async () => {
      const existingIdentity = await authority();
      const store = storeFor(existingIdentity);
      const acquired = acquire(store, "bun-snapshot-owner");
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
          const withDatabase = (write, run, overrides = {}) => withExistingSqliteRollbackDatabase(
            authority.databasePath, { ...options, write, ...overrides }, run,
          );
          let writes = 0;
          function write() {
            withDatabase(true, (database, transact) => transact(() => {
                const result = database.prepare(
                  "UPDATE managed_update_handoffs SET updated_at=updated_at+1 WHERE install_root = ?"
                ).run(authority.installKey);
                assert.equal(result.changes, 1);
              }));
            writes++;
            assert.ok(retained.every(({ database }) => !database.isOpen));
          }
          write();
          withDatabase(false, (database) => assert.equal(database.isTransaction, true));
          write();
          const failure = new Error("reader callback failed");
          assert.throws(
            () => withDatabase(false, () => { throw failure; }),
            (error) => error === failure,
          );
          write();
          assert.throws(
            () => withDatabase(true, () => assert.fail("Invalid snapshot admitted a writer"), {
                validate(database) {
                  options.validate(database);
                  throw failure;
                },
              }),
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
        lease: { owner: acquired.owner, updatedAt: acquired.updatedAt + 4 },
      });
    },
  );

  it("keeps a real writer excluded across nested child and owner reads until an update commits", async () => {
    const existingAuthority = await authority();
    const store = storeFor(existingAuthority);
    const admitted = acquire(store, "reserved-owner");
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
          const children = withDatabase(false, (reader) =>
            reader
              .prepare(
                "SELECT owner FROM managed_update_handoffs WHERE install_root>=? AND install_root<?",
              )
              .all(prefix, prefix + "\uffff"),
          );
          expect(children).toEqual([]);
          expect(store.current(admitted)).toBe(true);
          expect(probeWriterAdmission()).toEqual({ acquired: false, errcode: 5 });
          db.prepare(
            "UPDATE managed_update_handoffs SET updated_at=? WHERE install_root=? AND owner=?",
          ).run(admitted.updatedAt + 1, root, admitted.owner);
          expect(db.isTransaction).toBe(true);
          expect(probeWriterAdmission()).toEqual({ acquired: false, errcode: 5 });
        },
        {},
      );
    });
    expect(probeWriterAdmission("EXCLUSIVE")).toEqual({ acquired: true });
    expect(store.read(root)).toMatchObject({
      kind: "current",
      lease: { owner: admitted.owner, updatedAt: admitted.updatedAt + 1 },
    });
  });

  it("keeps one installation's fence current during another installation's live write", async ({
    signal,
  }) => {
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      const existingIdentity = captureUpdateCommandExecutorAuthority(fence);
      const store = storeFor(existingIdentity);
      const original = store.read(root);
      assert(original.kind === "current", "First installation fixture was not admitted");
      const otherRoot = path.join(root, "other-installation");
      fs.mkdirSync(otherRoot, { mode: 0o700 });
      const other = acquire(store, "other-owner", otherRoot);
      const child = spawnNode(
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
        [databasePath, otherRoot],
      );
      await withChild(child, signal, async (ready, finish) => {
        expect(ready).toEqual({ ready: true, changes: 1, inTransaction: true });
        expect(fs.statSync(databasePath + "-journal").size).toBeGreaterThan(512);
        // A live writer's RESERVED lock makes its journal non-hot. Readers
        // of another install key must still see their unchanged committed owner.
        expect(store.read(root)).toEqual(original);
        expect(store.owns(original.lease, "executor")).toBe(true);
        expect(() => fence.assertCurrent()).not.toThrow();
        child.send({ commit: true });
        await finish();
        expect(store.read(root)).toEqual(original);
        expect(() => fence.assertCurrent()).not.toThrow();
        const updatedOther = store.read(otherRoot);
        expect(updatedOther).toMatchObject({
          kind: "current",
          lease: { owner: other.owner, updatedAt: other.updatedAt + 1 },
        });
        if (updatedOther.kind === "current") {
          expect(store.release(updatedOther.lease)).toBe(true);
        }
      });
    });
  });

  it("excludes a real writer until public release commits after its recorded child settles", async ({
    signal,
  }) => {
    const existingIdentity = await authority();
    const store = storeFor(existingIdentity);
    const parent = acquire(store, "parent-owner");
    const childKey = `${root}/.openclaw-update-child-${randomUUID()}`;
    const recordedChild = acquire(store, "child-owner", childKey);
    const child = spawnNode(
      `
          process.once("message", () => process.disconnect());
          process.send({ ready: true });
        `,
      [],
      true,
    );
    await withChild(child, signal, async (ready, finish) => {
      expect(ready).toEqual({ ready: true });
      assert(child.pid !== undefined, "Release child fixture has no process identity");
      const boundChild = store.bind(recordedChild, child.pid);
      assert(boundChild, "Release child fixture was not bound");
      expect(store.release(parent)).toBe(false);
      expect(store.release(boundChild)).toBe(false);
      expect(store.current(parent)).toBe(true);
      expect(store.current(boundChild)).toBe(true);
      child.send({ exit: true });
      await finish();
      expect(store.release(parent)).toBe(false);
      expect(store.release(boundChild)).toBe(true);
      expect(store.read(childKey)).toEqual({ kind: "absent" });

      const boundaries: string[] = [];
      observeWritableDatabase((db) => {
        const prepare = db.prepare.bind(db);
        db.prepare = (sql) => {
          const statement = prepare(sql);
          const run = statement.run.bind(statement);
          statement.run = (...values) => {
            // Public release has completed its in-transaction child check when
            // its mutation reaches SQLite. Observe the real statement unchanged.
            expect(db.isTransaction).toBe(true);
            expect(values).toContain(parent.key);
            expect(values).toContain(parent.owner);
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
      });
      expect(store.release(parent)).toBe(true);
      expect(boundaries).toEqual(["before-write", "after-write", "before-commit", "committed"]);
      expect(probeWriterAdmission()).toEqual({ acquired: true });
      expect(store.read(root)).toEqual({ kind: "absent" });
    });
  });

  describe.each(["admission", "release"] as const)("%s", (phase) => {
    // Admission covers each guard; release repeats missing storage and identity revocation.
    it.each(
      phase === "admission"
        ? damage
        : damage.filter(([name]) =>
            ["missing database", "replacement parent with the same database inode"].includes(name),
          ),
    )("preserves %s without repair", async (_name, apply) => {
      const existingAuthority = await authority();
      let before: ReturnType<typeof snapshot> | undefined;
      const repairSpies = [vi.spyOn(fs, "mkdirSync"), vi.spyOn(fs, "chmodSync")];
      const revoke = () => {
        apply();
        before = snapshot();
        repairSpies.forEach((spy) => spy.mockClear());
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
      for (const spy of repairSpies) {
        expect(spy.mock.calls.filter(([file]) => String(file).startsWith(root + path.sep))).toEqual(
          [],
        );
      }
    });
  });

  describe.each(["acquire", "release"] as const)("%s transaction", (operation) => {
    it.each([
      { boundary: "after-open", target: "database" },
      { boundary: "after-begin", target: "parent" },
      { boundary: "before-commit", target: "database" },
    ] as const)("refuses a replaced $target at $boundary", async ({ boundary, target }) => {
      const existingAuthority = await authority();
      const store = storeFor(existingAuthority);
      const admitted = operation === "release" ? acquire(store, "release-owner") : null;
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
          replaceParent();
        }
      };
      observeWritableDatabase((db) => {
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
      });
      expect(() =>
        admitted ? store.release(admitted) : store.acquire(root, "next-owner", { kind: "update" }),
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
