// Synthetic canonical admission ordering and lifecycle proof; checks use real native SQLite.
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sqlite from "../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { readSqliteIntegrityFileIdentity } from "../infra/sqlite-file-generation.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as pidAlive from "../shared/pid-alive.js";
import { disposeOpenClawAgentDatabaseByPath } from "./openclaw-agent-db-disposal.js";
import * as agentLeases from "./openclaw-agent-db-lease.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  inspectOpenClawAgentDatabaseOwner,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
  runOpenClawAgentWriteTransaction,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

// Most cases inspect one returned handle after the scoped operation, without
// competing opens. Retention tests keep their work inside the actual owner.
function openOpenClawAgentDatabaseAsync(options: Parameters<typeof openOpenClawAgentDatabase>[0]) {
  return withOpenClawAgentDatabaseAsync(options, (database) => database);
}

const roots: string[] = [];
const independent: DatabaseSync[] = [];
const realOpen = sqlite.openNodeSqliteDatabase;

function tempRoot(prefix: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

function duringWorker(run: (work: Promise<void>) => Promise<void>) {
  const check = integrityWorker.assertSqliteIntegrityInWorker;
  return vi
    .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
    .mockImplementation((...args) => run(check(...args)));
}

function afterWorker(checkpoint: () => void) {
  return duringWorker(async (work) => {
    await work;
    checkpoint();
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of independent.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function seed(freshIdentity = false) {
  const options = {
    agentId: "synthetic-owner",
    env: { OPENCLAW_STATE_DIR: tempRoot("agent-open-order-") },
  };
  const state = openOpenClawStateDatabase({ env: options.env });
  const database = openOpenClawAgentDatabase(options);
  database.db.exec(`
    INSERT INTO memory_index_chunks
      (id,path,start_line,end_line,hash,model,text,embedding,updated_at)
      VALUES ('synthetic-parent','synthetic',1,1,'hash','synthetic','text',X'',1);
    INSERT INTO memory_index_chunk_recall_metadata (chunk_id, importance)
      VALUES ('synthetic-parent',1);
  `);
  expect(database.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const pathname = database.path;
  closeOpenClawAgentDatabasesForTest();
  // Independent fixture writers model unclean state that requires physical admission checks.
  revokeSqliteDatabaseAdmissionsForPath(pathname);
  if (freshIdentity) {
    fs.copyFileSync(pathname, `${pathname}.replacement`);
    fs.renameSync(`${pathname}.replacement`, pathname);
  }
  const writer = realOpen(pathname);
  independent.push(writer);
  writer.exec("PRAGMA foreign_keys=OFF;");
  return {
    options,
    pathname,
    writer,
    state,
    open: () => openOpenClawAgentDatabase(options),
    openAsync: () => openOpenClawAgentDatabaseAsync(options),
    close: (owner?: string) => closeOpenClawAgentDatabaseByPath(pathname, owner),
    dispose: () => disposeOpenClawAgentDatabaseByPath(pathname, { env: options.env }),
    revoke: () => revokeSqliteDatabaseAdmissionsForPath(pathname),
    leases: () => state.db.prepare("SELECT lease_id FROM agent_database_leases").all(),
    assertNoLeases: () =>
      assertNoOpenClawAgentDatabaseLeases(options.agentId, { env: options.env }),
    write: () => ordinaryWrite(options),
  };
}

function corruptForeignKey(writer: DatabaseSync) {
  writer.exec("DELETE FROM memory_index_chunks WHERE id='synthetic-parent';");
  expect(writer.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
}

function tracePhysicalChecks(
  pathname: string,
  gate?: "integrity" | "foreign-key",
  commit?: () => void,
) {
  let completed = false;
  const events: string[] = [];
  const checked = (phase: "integrity" | "foreign-key") => {
    events.push(`${phase}-completed`);
    if (commit && !completed && gate === phase) {
      completed = true;
      commit();
      events.push("external-commit");
    }
  };
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((location, options) => {
    const db = realOpen(location, options);
    if (location !== pathname) {
      return db;
    }
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (
        sql === "PRAGMA integrity_check;" ||
        sql === "PRAGMA integrity_check('memory_index_chunk_recall_metadata');"
      ) {
        const all = statement.all.bind(statement);
        statement.all = () => {
          const rows = all();
          checked("integrity");
          return rows;
        };
      }
      if (
        sql === "PRAGMA foreign_key_check;" ||
        sql === "PRAGMA foreign_key_check('memory_index_chunk_recall_metadata');"
      ) {
        const iterate = statement.iterate.bind(statement);
        statement.iterate = function* () {
          yield* iterate();
          checked("foreign-key");
          return undefined;
        };
      }
      return statement;
    };
    return db;
  });
  return { events, didCommit: () => completed };
}

function ordinaryWrite(options: Parameters<typeof openOpenClawAgentDatabase>[0]) {
  return runOpenClawAgentWriteTransaction((database) => {
    database.db
      .prepare(
        "INSERT INTO cache_entries (scope,key,value_json,updated_at) VALUES ('synthetic','proof','{}',1)",
      )
      .run();
    return database.db
      .prepare("SELECT count(*) AS n FROM cache_entries WHERE scope='synthetic'")
      .get();
  }, options);
}

describe("physical-open admission ordering", () => {
  it("rejects an external FK violation committed between table integrity and FK checks", () => {
    const f = seed();
    const trace = tracePhysicalChecks(f.pathname, "integrity", () => corruptForeignKey(f.writer));
    expect(f.open).toThrow(/foreign_key_check failed/);
    expect(trace.events).toEqual([
      "integrity-completed",
      "external-commit",
      "foreign-key-completed",
    ]);
  });

  it("exposes and writes after an external FK violation committed after its table FK check", () => {
    const f = seed();
    const trace = tracePhysicalChecks(f.pathname, "foreign-key", () => corruptForeignKey(f.writer));
    const database = f.open();
    expect(trace.events).toEqual([
      "integrity-completed",
      "foreign-key-completed",
      "external-commit",
    ]);
    expect(database.db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
    expect(f.write()).toEqual({ n: 1 });
  });

  it("trusts a live cached handle but rejects the same FK violation after disposal", async () => {
    const f = seed();
    const first = f.open();
    corruptForeignKey(f.writer);
    expect(f.open()).toBe(first);
    expect(f.write()).toEqual({ n: 1 });
    expect(await f.dispose()).toBe(true);
    f.revoke();
    expect(f.open).toThrow(/foreign_key_check failed/);
  });
});

describe.each(["sync", "async"] as const)("%s replacement admission", (mode) => {
  it.each(["agent-id", "role", "version"] as const)(
    "rejects %s drift before exposure",
    async (replacement) => {
      const f = seed(replacement !== "version");
      if (replacement !== "version") {
        f.writer.exec(
          `UPDATE schema_meta SET ${replacement === "agent-id" ? "agent_id='replacement'" : "role='global'"} WHERE meta_key='primary'`,
        );
      }
      const drift = () => f.writer.exec("PRAGMA user_version=9999;");
      const failure = /belongs to agent replacement|schema role global|schema version 9999/;
      if (mode === "sync") {
        const trace = tracePhysicalChecks(f.pathname, "foreign-key", drift);
        expect(f.open).toThrow(failure);
        expect(trace.didCommit()).toBe(replacement === "version");
        if (replacement !== "version") {
          expect(trace.events).toEqual([]);
        }
        expect(
          f.writer.prepare("SELECT count(*) AS n FROM cache_entries WHERE scope='synthetic'").get(),
        ).toEqual({ n: 0 });
      } else {
        const worker = afterWorker(drift);
        await expect(f.openAsync()).rejects.toThrow(failure);
        expect(worker).toHaveBeenCalledTimes(replacement === "version" ? 1 : 0);
        expect(f.assertNoLeases).not.toThrow();
      }
    },
  );
});

describe("asynchronous canonical admission", () => {
  it("observes an independent WAL commit between the child's integrity and FK checks", async () => {
    const { pathname, writer } = seed();
    expect(writer.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    const sqliteLibraryModule = new URL("../infra/bun-sqlite-library.ts", import.meta.url).href;
    const integrityWorkerModule = new URL("../infra/sqlite-integrity.worker.ts", import.meta.url)
      .href;
    const commitBetweenChecks = `
        import { execFileSync } from "node:child_process";
        const { ensureSqliteLibrarySelected } = await import(${JSON.stringify(sqliteLibraryModule)});
        ensureSqliteLibrarySelected();
        const { DatabaseSync } = await import("node:sqlite");
        const prepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function (sql) {
          const statement = prepare.call(this, sql);
          if (sql === "PRAGMA integrity_check;") {
            const all = statement.all.bind(statement);
            statement.all = () => {
              const rows = all();
              // A separate process commits before the real FK check begins.
              execFileSync(process.execPath, ["-e", ${JSON.stringify(`
                if (process.versions.bun && process.env.OPENCLAW_SQLITE_LIBRARY) {
                  require("bun:sqlite").Database.setCustomSQLite(process.env.OPENCLAW_SQLITE_LIBRARY);
                }
                const { DatabaseSync } = require("node:sqlite");
                const writer = new DatabaseSync(process.env.OPENCLAW_AGENT_DB_COMMIT_PATH);
                writer.exec("PRAGMA foreign_keys=OFF; DELETE FROM memory_index_chunks WHERE id='synthetic-parent';");
                writer.close();
              `)}], { timeout: 5000, env: process.env });
              process.send({ phase: "external-commit" });
              return rows;
            };
          }
          return statement;
        };
        await import(${JSON.stringify(integrityWorkerModule)});
      `;
    const fixtureRoot = tempRoot("sqlite-integrity-wal-fixture-");
    const fixturePath = path.join(fixtureRoot, "worker.mts");
    fs.writeFileSync(fixturePath, commitBetweenChecks);
    const worker = fork(fixturePath, [pathname], {
      execArgv: process.versions.bun ? [] : ["--import", "tsx"],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, OPENCLAW_AGENT_DB_COMMIT_PATH: pathname },
    });
    const closed = new Promise<void>((resolve) => {
      worker.once("close", () => resolve());
    });
    let committed = false;
    const completed = createDeferredCore<integrityWorker.SqliteIntegrityWorkerResult>();
    let result: integrityWorker.SqliteIntegrityWorkerResult | undefined;
    worker.on(
      "message",
      (message: integrityWorker.SqliteIntegrityWorkerResult | { phase: string }) => {
        if ("phase" in message) {
          committed ||= message.phase === "external-commit";
        } else {
          result = message;
        }
      },
    );
    worker.once("error", completed.reject);
    worker.once("close", (code) => {
      if (code === 0 && result) {
        completed.resolve(result);
      } else {
        completed.reject(new Error(`integrity fixture exited ${code} without its result`));
      }
    });
    worker.send(
      {
        pathname,
        databaseLabel: pathname,
        identity: readSqliteIntegrityFileIdentity(pathname),
        busyTimeoutMs: 5000,
      } satisfies integrityWorker.SqliteIntegrityWorkerInput,
      (error) => {
        if (error) {
          completed.reject(error);
        }
      },
    );
    try {
      await expect(completed.promise).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("foreign_key_check failed") },
      });
      expect(committed).toBe(true);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
      }
      await closed;
    }
  });

  it("does not revoke another owner's pending admission while closing a registered path", async () => {
    const f = seed();
    const opening = f.openAsync();
    expect(f.close("foreign-owner")).toBe(false);
    const database = await opening;
    expect(database.db.isOpen).toBe(true);
    expect(f.close(f.options.agentId)).toBe(true);
    expect(database.db.isOpen).toBe(false);
  });

  it("keeps failed lease cleanup with its original agent owner", async () => {
    const f = seed();
    const { state, writer } = f;
    writer.exec("PRAGMA user_version=999;");
    state.db.exec(`CREATE TEMP TRIGGER fail_owned_release BEFORE DELETE ON agent_database_leases
      BEGIN SELECT RAISE(ABORT, 'synthetic blocked release'); END`);
    try {
      await expect(f.openAsync()).rejects.toThrow("synthetic blocked release");
    } finally {
      state.db.exec("DROP TRIGGER fail_owned_release");
    }
    expect(f.leases()).toHaveLength(1);
    expect(f.close("foreign-owner")).toBe(false);
    expect(f.leases()).toHaveLength(1);
    f.close(f.options.agentId);
    expect(f.leases()).toEqual([]);
  });

  it.each([null, 1])(
    "preserves process-start identity semantics across await (initial: %s)",
    async (initial) => {
      const f = seed();
      const identity = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(initial);
      afterWorker(() => identity.mockReturnValue(2));
      const opening = f.openAsync();
      if (initial === null) {
        await expect(opening).resolves.toMatchObject({ agentId: f.options.agentId });
      } else {
        await expect(opening).rejects.toThrow(/lost its runtime lease/);
      }
    },
  );

  it("rejects a lost original lease before publishing the checked handle", async () => {
    const f = seed();
    afterWorker(() => {
      const lease = f.state.db
        .prepare("SELECT lease_id FROM agent_database_leases WHERE path=?")
        .get(f.pathname);
      expect(lease).toBeDefined();
      releaseOpenClawAgentDatabaseLease(String(lease?.lease_id), { env: f.options.env });
    });
    await expect(f.openAsync()).rejects.toThrow(/lost its runtime lease/);
    expect(f.leases()).toEqual([]);
  });

  it("refuses physical index corruption without changing unrelated damage", async () => {
    const f = seed();
    const { pathname, writer } = f;
    writer.exec(`
      INSERT INTO cache_entries (scope,key,value_json,expires_at,updated_at)
      VALUES ('scope-a','key-a','{}',100,1);
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
    writer.exec(`
        CREATE TABLE unsafe_records (id INTEGER PRIMARY KEY, value TEXT, alternate TEXT);
        CREATE INDEX unsafe_records_value ON unsafe_records(value);
        INSERT INTO unsafe_records (value,alternate) VALUES ('alpha','zeta'),('beta','eta');
      `);
    writer.enableDefensive?.(false);
    writer.exec("PRAGMA writable_schema=ON;");
    writer.exec(`UPDATE sqlite_schema SET sql=
      'CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL'
      WHERE name='idx_agent_cache_expiry';`);
    writer.exec(`UPDATE sqlite_schema SET sql=
        'CREATE INDEX unsafe_records_value ON unsafe_records(alternate)'
        WHERE name='unsafe_records_value';`);
    const version = Number(writer.prepare("PRAGMA schema_version").get()?.schema_version);
    writer.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${version + 1};`);
    const findings = writer.prepare("PRAGMA integrity_check").all();
    expect(findings).not.toEqual([{ integrity_check: "ok" }]);
    writer.close();
    await expect(f.openAsync()).rejects.toThrow(/integrity_check failed.*openclaw doctor --fix/);
    using unchanged = realOpen(pathname, { readOnly: true });
    expect(unchanged.prepare("PRAGMA integrity_check").all()).toEqual(findings);
    expect(unchanged.prepare("SELECT key FROM cache_entries NOT INDEXED").all()).toEqual([
      { key: "key-a" },
    ]);
  });

  it.each([false, true])("retains its state owner across await (ambient: %s)", async (ambient) => {
    const f = seed();
    const { options, pathname } = f;
    const originalEnv = { ...options.env };
    const nextRoot = tempRoot("agent-open-next-owner-");
    vi.stubEnv("OPENCLAW_STATE_DIR", originalEnv.OPENCLAW_STATE_DIR);
    duringWorker(async (work) => {
      options.env.OPENCLAW_STATE_DIR = nextRoot;
      vi.stubEnv("OPENCLAW_STATE_DIR", nextRoot);
      await work;
    });
    try {
      const opening = openOpenClawAgentDatabaseAsync({
        agentId: options.agentId,
        path: pathname,
        ...(ambient ? {} : { env: options.env }),
      });
      await expect(opening).resolves.toMatchObject({ path: pathname });
      expect(f.leases()).toHaveLength(1);
      f.close();
      expect(f.leases()).toEqual([]);
      expect(fs.readdirSync(nextRoot)).toEqual([]);
    } finally {
      options.env.OPENCLAW_STATE_DIR = originalEnv.OPENCLAW_STATE_DIR;
      vi.stubEnv("OPENCLAW_STATE_DIR", originalEnv.OPENCLAW_STATE_DIR);
      for (const lease of f.leases()) {
        releaseOpenClawAgentDatabaseLease(String(lease.lease_id), { env: originalEnv });
      }
    }
  });

  it("publishes a registered replacement database after full checks and before yielding", async () => {
    const options = {
      agentId: "synthetic-new",
      env: { OPENCLAW_STATE_DIR: tempRoot("agent-open-empty-") },
    };
    const original = openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabaseByPath(original.path);
    fs.renameSync(path.dirname(original.path), `${path.dirname(original.path)}-retired`);
    const pathname = resolveOpenClawAgentSqlitePath(options);
    const trace = tracePhysicalChecks(pathname);
    const opening = openOpenClawAgentDatabaseAsync(options);
    const beforeYield = {
      checks: [...trace.events],
      owner: inspectOpenClawAgentDatabaseOwner(pathname),
    };
    const database = await opening;
    expect(beforeYield).toEqual({
      checks: ["integrity-completed", "foreign-key-completed"],
      owner: { status: "owned", agentId: options.agentId },
    });
    expect(database.db.prepare("SELECT agent_id FROM schema_meta").get()).toEqual({
      agent_id: options.agentId,
    });
    expect(ordinaryWrite(options)).toEqual({ n: 1 });
    expect(listOpenClawRegisteredAgentDatabases({ env: options.env })).toEqual([
      expect.objectContaining({ agentId: options.agentId, path: database.path }),
    ]);
  });

  it("keeps a nonempty unversioned database with no application tables on async admission", async () => {
    const options = {
      agentId: "synthetic-retained",
      env: { OPENCLAW_STATE_DIR: tempRoot("agent-open-retained-pages-") },
    };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    const writer = realOpen(pathname);
    independent.push(writer);
    writer.exec(`
      CREATE TABLE retired (value BLOB);
      INSERT INTO retired VALUES (zeroblob(16384));
      DROP TABLE retired;
    `);
    expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(writer.prepare("PRAGMA page_count").get()?.page_count).toBeGreaterThan(0);
    expect(
      writer.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all(),
    ).toEqual([]);
    writer.close();
    const check = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    const database = await openOpenClawAgentDatabaseAsync(options);
    expect(check).toHaveBeenCalledOnce();
    expect(database.agentId).toBe(options.agentId);
    expect(ordinaryWrite(options)).toEqual({ n: 1 });
  });

  it("checks an older schema before the unchanged doctor migration refusal", async () => {
    const { options, writer } = seed();
    writer.exec("PRAGMA user_version=18; UPDATE schema_meta SET schema_version=18;");
    const check = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    await expect(openOpenClawAgentDatabaseAsync(options)).rejects.toThrow(
      /uses schema version 18; stop active agents/,
    );
    expect(check).toHaveBeenCalledOnce();
    expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 18 });
  });

  it("preserves point-in-time admission when a writer commits after the Worker check", async () => {
    const f = seed();
    afterWorker(() => corruptForeignKey(f.writer));
    const database = await f.openAsync();
    expect(database.db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
    expect(f.write()).toEqual({ n: 1 });
  });

  it("reopens an evicted validated database while a WAL writer remains active", async () => {
    const f = seed();
    const { writer } = f;
    f.open();
    f.close();
    writer.exec("BEGIN IMMEDIATE;");
    try {
      expect((await f.openAsync()).db.isOpen).toBe(true);
      expect(writer.isTransaction).toBe(true);
    } finally {
      writer.exec("ROLLBACK;");
    }
    expect(f.write()).toEqual({ n: 1 });
  });

  it("rejects an existing FK violation before publishing a writable handle", async () => {
    const { options, writer } = seed();
    corruptForeignKey(writer);
    await expect(openOpenClawAgentDatabaseAsync(options)).rejects.toThrow(
      /foreign_key_check failed/,
    );
    expect(() =>
      assertNoOpenClawAgentDatabaseLeases(options.agentId, { env: options.env }),
    ).not.toThrow();
    expect(
      writer.prepare("SELECT count(*) AS n FROM cache_entries WHERE scope='synthetic'").get(),
    ).toEqual({ n: 0 });
  });

  it("rechecks corruption after async handle disposal", async () => {
    const f = seed();
    await f.openAsync();
    expect(await f.dispose()).toBe(true);
    f.revoke();
    corruptForeignKey(f.writer);
    await expect(f.openAsync()).rejects.toThrow(/foreign_key_check failed/);
  });

  it("joins the real read-only Worker before releasing a revoked admission lease", async () => {
    const f = seed();
    const { options, writer } = f;
    writer.exec(
      "INSERT INTO cache_entries (scope,key,blob,updated_at) VALUES ('load','large',zeroblob(8388608),1)",
    );
    let drain: Promise<void> | undefined;
    let completed = false;
    duringWorker((work) => {
      const native = work.finally(() => {
        completed = true;
      });
      drain = closeOpenClawAgentDatabasesAsync(options.env.OPENCLAW_STATE_DIR);
      expect(completed).toBe(false);
      expect(f.assertNoLeases).toThrow(/still open/);
      return native;
    });
    await expect(f.openAsync()).rejects.toThrow(/revoked/);
    await drain;
    expect(completed).toBe(true);
    expect(f.assertNoLeases).not.toThrow();
    writer.exec("BEGIN IMMEDIATE; ROLLBACK;");
  });

  it.each([false, true])(
    "preserves a synchronous replacement when old async close fails=%s",
    async (failClose) => {
      const f = seed();
      const { pathname, writer } = f;
      writer.exec(
        "INSERT INTO cache_entries (scope,key,blob,updated_at) VALUES ('load','large',zeroblob(8388608),1)",
      );
      let source: DatabaseSync | undefined;
      let replacement: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
      vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((location, dbOptions) => {
        const db = realOpen(location, dbOptions);
        if (location === pathname && !source) {
          source = db;
        }
        return db;
      });
      duringWorker((native) => {
        replacement = f.open();
        if (failClose && source) {
          const close = source.close.bind(source);
          let failed = false;
          source.close = () => {
            if (!failed) {
              failed = true;
              throw new Error("synthetic native close failure");
            }
            close();
          };
        }
        return native;
      });
      await expect(f.openAsync()).rejects.toThrow(
        failClose ? /synthetic native close failure/ : /revoked/,
      );
      expect(replacement?.db.isOpen).toBe(true);
      expect(f.open()).toBe(replacement);
      expect(f.write()).toEqual({ n: 1 });
      expect(source?.isOpen).toBe(failClose);
      expect(f.close()).toBe(true);
      expect(source?.isOpen).toBe(false);
      expect(f.assertNoLeases).not.toThrow();
    },
  );
});

it.each(["sync", "async"] as const)(
  "retains the original failed lease release for retry (%s)",
  async (mode) => {
    const f = seed();
    const { options, pathname } = f;
    const release = vi.spyOn(agentLeases, "releaseOpenClawAgentDatabaseLease");
    release.mockImplementation(() => {
      throw new Error("synthetic lease release failure");
    });
    const closeFailure = {
      message: "Agent database close failed",
      errors: expect.arrayContaining([
        expect.objectContaining({ message: "synthetic lease release failure" }),
      ]),
    };
    if (mode === "sync") {
      expect(() =>
        openOpenClawAgentDatabase({ ...options, agentId: "other-owner", path: pathname }),
      ).toThrow("synthetic lease release failure");
    } else {
      const admission = f.openAsync();
      await Promise.all([
        expect(admission).rejects.toThrow("synthetic lease release failure"),
        expect(closeOpenClawAgentDatabasesAsync()).rejects.toMatchObject(closeFailure),
      ]);
    }
    expect(f.leases()).toHaveLength(1);
    const originalLease = f.leases()[0];
    const nextRoot = tempRoot("agent-close-next-owner-");
    options.env.OPENCLAW_STATE_DIR = nextRoot;
    await expect(closeOpenClawAgentDatabasesAsync()).rejects.toMatchObject(closeFailure);
    expect(f.leases()).toEqual([originalLease]);
    release.mockRestore();
    await closeOpenClawAgentDatabasesAsync();
    expect(f.leases()).toEqual([]);
    expect(fs.readdirSync(nextRoot)).toEqual([]);
  },
);

it("checks the original lease while another shared-state WAL writer is active", () => {
  const f = seed();
  const { options, state } = f;
  const database = f.open();
  const row = state.db.prepare("SELECT lease_id FROM agent_database_leases;").get() as {
    lease_id: string;
  };
  const blocker = realOpen(state.path);
  independent.push(blocker);
  blocker.exec("BEGIN IMMEDIATE;");
  try {
    expect(() =>
      agentLeases.assertOpenClawAgentDatabaseLease(row.lease_id, {
        agentId: database.agentId,
        path: database.path,
        env: options.env,
      }),
    ).not.toThrow();
  } finally {
    blocker.exec("ROLLBACK;");
  }
});

it("joins only the pending admissions in the closing runtime root", async () => {
  const first = seed();
  const second = seed();
  const firstOpen = first.openAsync();
  const rejected = expect(firstOpen).rejects.toThrow("revoked");
  const secondOpen = second.openAsync();
  await closeOpenClawAgentDatabasesAsync(first.options.env.OPENCLAW_STATE_DIR);
  await rejected;
  const secondDatabase = await secondOpen;
  expect(secondDatabase.db.isOpen).toBe(true);
  expect(second.write()).toEqual({ n: 1 });
  expect(first.leases()).toEqual([]);
  expect(second.leases()).toHaveLength(1);
});
