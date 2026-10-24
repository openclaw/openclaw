import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import * as sqlite from "../infra/node-sqlite.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  assertNoOpenClawAgentDatabaseLeases,
  claimOpenClawAgentDatabaseLease,
  prepareOpenClawAgentDatabaseWorkerLease as prepareWorkerLease,
  releaseOpenClawAgentDatabaseLease as releaseAgentLease,
  runWithAgentDatabaseMaintenanceAuthority as withMaintenanceAuthority,
} from "./openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease as withMaintenance } from "./openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance as migrateAgentDb } from "./openclaw-agent-db-maintenance.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import { getOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen as getOpenAgentDb,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase as openAgentDb,
} from "./openclaw-agent-db.js";
import { seedLegacyAgentFixture } from "./openclaw-agent-db.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { runExistingOpenClawStateWriteTransaction as writeExistingState } from "./openclaw-state-db-existing-write.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(roots);
});

function fixture() {
  const root = makeTempDir(roots, "agent-maintenance-");
  const env = { OPENCLAW_STATE_DIR: root };
  const database = openAgentDb({ agentId: "worker", env });
  const options = { agentId: "worker", pathname: database.path };
  database.db.exec(`
    INSERT INTO cache_entries (scope,key,value_json,expires_at,updated_at)
      VALUES ('maintenance','retained','{"retained":true}',100,1);
  `);
  closeOpenClawAgentDatabasesForTest();
  const state = openOpenClawStateDatabase({ env });
  return {
    env,
    options,
    state,
    leases: () => state.db.prepare("SELECT lease_id FROM agent_database_leases").all(),
    owners: () => state.db.prepare("SELECT owner FROM state_leases").all(),
    prepare: () =>
      prepareWorkerLease({ agentId: "worker", path: database.path, env }, state, randomUUID()),
  };
}

function withDatabase<T>(
  pathname: string,
  run: (database: ReturnType<typeof sqlite.openNodeSqliteDatabase>) => T,
  readOnly = false,
) {
  using database = sqlite.openNodeSqliteDatabase(pathname, { readOnly });

  return run(database);
}

function readIndexState(pathname: string) {
  return withDatabase(
    pathname,
    (database) => ({
      index: database
        .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_cache_expiry'")
        .get(),
      integrity: database.prepare("PRAGMA integrity_check;").all(),
      retained: database.prepare("SELECT value_json FROM cache_entries").all(),
    }),
    true,
  );
}

function installIndexDrift(pathname: string) {
  withDatabase(pathname, (database) => {
    database.exec(`
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
    // The claimed definition disagrees with the b-tree, exercising genuine integrity failure.
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema=ON;");
    database
      .prepare("UPDATE sqlite_schema SET sql=? WHERE name='idx_agent_cache_expiry'")
      .run(
        "CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL",
      );
    database.exec("PRAGMA writable_schema=OFF;");
    database.exec(
      `PRAGMA schema_version=${readSqliteNumberPragma(database, "schema_version") + 1};`,
    );
  });
}

function afterFailedIntegrity(run: () => void, once = false) {
  const check = integrityWorker.assertSqliteIntegrityInWorker;
  const spy = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
  return spy[once ? "mockImplementationOnce" : "mockImplementation"](async (...args) => {
    let failed = false;
    let failure: unknown;
    try {
      await check(...args);
    } catch (error) {
      failed = true;
      failure = error;
    }
    expect(failed).toBe(true);
    run();
    throw failure;
  });
}

function leaseOptions(env: NodeJS.ProcessEnv) {
  return {
    ...AGENT_DATABASE_MAINTENANCE_LEASE,
    database: { scope: "shared" as const, options: { env } },
    leaseMs: 60_000,
    waitMs: 5_000,
  };
}

function withAbortableMaintenance<T>(
  f: ReturnType<typeof fixture>,
  signal: AbortSignal,
  run: (maintenance: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
  // Exercise the existing lease owner's abort signal without adding a production
  // cancellation option or replacing the closure-bound maintenance context.
  return withOpenClawStateLease(
    {
      ...leaseOptions(f.env),
      heartbeat: "worker",
      signal,
    },
    (maintenance) => {
      assertNoOpenClawAgentDatabaseLeases(maintenance, { env: f.env });
      return withMaintenanceAuthority(maintenance, resolveOpenClawStateSqlitePath(f.env), () =>
        run(maintenance),
      );
    },
  );
}

describe("asynchronous agent database maintenance admission", () => {
  it("checks maintenance authority on the held transaction without opening separate readers", async () => {
    const f = fixture();
    await withMaintenance({ env: f.env, schemaPolicy: "existing" }, async (maintenance) => {
      writeExistingState(
        ({ db }) => {
          const reads = vi.spyOn(stateReads, "withOpenClawStateDatabaseReadOnly");
          try {
            maintenance.assertOwnedInTransaction(db);
            expect(reads).not.toHaveBeenCalled();
          } finally {
            reads.mockRestore();
          }
        },
        { env: f.env },
        {
          schemaSql: extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "schema_meta"),
          operationLabel: "maintenance authority regression",
        },
      );
    });
  });

  it("reuses one integrity process across agent maintenance while checking each file afresh", async () => {
    const f = fixture();
    const createTarget = (agentId: string) => {
      const database = openAgentDb({ agentId, env: f.env });
      const validation = expectDefined(
        getOpenClawAgentDatabaseValidation(database),
        "verified maintenance target",
      );
      return { agentId, pathname: database.path, validation };
    };
    const second = createTarget("second");
    const third = createTarget("third");
    await closeOpenClawAgentDatabasesAsync();
    const validity = () =>
      [second, third].map(({ validation }) => Atomics.load(new Int32Array(validation.valid), 0));
    expect(validity()).toEqual([1, 1]);
    vi.mocked(fork).mockClear();
    const entry = resolveRuntimeProcessEntrypointUrl("sqliteIntegrity").href;
    const children = () =>
      vi.mocked(fork).mock.calls.flatMap((args, index) => {
        if (String(args[0]) !== entry) {
          return [];
        }
        const result = expectDefined(vi.mocked(fork).mock.results[index], "integrity fork result");
        if (result.type !== "return") {
          throw new Error("Integrity worker did not start");
        }
        return [result.value];
      });
    await withMaintenance({ env: f.env }, async (maintenance) => {
      expect(validity()).toEqual([0, 0]);
      await migrateAgentDb(f.options, maintenance);
      await withMaintenance({ env: f.env }, async (nested) => {
        await migrateAgentDb(second, nested);
      });
      await migrateAgentDb(third, maintenance);
      expect(children()).toHaveLength(1);
      const child = expectDefined(children()[0], "reused integrity child");
      expect(child.exitCode).toBeNull();

      installIndexDrift(f.options.pathname);
      await expect(
        integrityWorker.assertSqliteIntegrityInWorker(f.options.pathname, 250, maintenance.signal),
      ).rejects.toMatchObject({ name: "SqliteIntegrityError" });
      expect(child.exitCode).toBe(0);
      await migrateAgentDb(f.options, maintenance);
      expect(readIndexState(f.options.pathname).integrity).toEqual([{ integrity_check: "ok" }]);
      maintenance.assertOwned();
    });
    expect(children().every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
      true,
    );
    expect(f.owners()).toEqual([]);
  });

  it("refuses a prepared Worker claim during plain maintenance", async () => {
    const f = fixture();
    const before = readIndexState(f.options.pathname);
    await withMaintenance({ env: f.env }, async () => {
      const prepared = f.prepare();
      expect(() => prepared.claim()).toThrow(/maintenance is in progress/);
      expect(f.leases()).toEqual([]);
    });
    expect(readIndexState(f.options.pathname)).toEqual(before);
  });

  it("refuses a delegated prepared open before publishing a native handle during maintenance", async () => {
    const f = fixture();
    const options = { agentId: "worker", env: f.env };
    const prepared = f.prepare();
    const leaseId = prepared.claim();
    const registered = vi.fn();
    const open = sqlite.openNodeSqliteDatabase;
    let native: ReturnType<typeof open> | undefined;
    vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, openOptions) => {
      const database = open(pathname, openOptions);
      if (pathname === f.options.pathname && openOptions?.readOnly !== true) {
        native = database;
      }
      return database;
    });
    try {
      // The Worker receives an admitted claim independently of its native open.
      await withOpenClawStateLease(leaseOptions(f.env), (maintenance) =>
        withMaintenanceAuthority(maintenance, resolveOpenClawStateSqlitePath(f.env), async () => {
          expect(() =>
            openAgentDb(
              options,
              { ...prepared, claim: () => leaseId },
              { starting: registered, committed: registered },
            ),
          ).toThrow(/maintenance is in progress/);
          expect(native?.isOpen).toBe(false);
          expect(registered).not.toHaveBeenCalled();
          expect(getOpenAgentDb(options)).toBeUndefined();
          expect(f.leases()).toEqual([]);
        }),
      );
    } finally {
      releaseAgentLease(leaseId, { env: f.env });
    }
  });

  it.each(["expiry", "replacement", "abort", "owner", "version"] as const)(
    "fences Worker resume after %s following integrity failure",
    async (loss) => {
      const f = fixture();
      installIndexDrift(f.options.pathname);
      const before = readIndexState(f.options.pathname);
      const abort = new AbortController();
      const changedDatabase = loss === "owner" || loss === "version";
      const spy = afterFailedIntegrity(() => {
        if (changedDatabase) {
          withDatabase(f.options.pathname, (db) => {
            if (loss === "owner") {
              db.prepare("UPDATE schema_meta SET agent_id=? WHERE meta_key='primary'").run(
                "other-agent",
              );
            } else {
              db.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
            }
          });
        } else if (loss === "abort") {
          abort.abort(new Error("synthetic maintenance abort"));
        } else {
          f.state.db
            .prepare(
              `UPDATE state_leases SET ${loss === "expiry" ? "expires_at=0" : "owner='successor'"} WHERE scope=? AND lease_key=?`,
            )
            .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
        }
      }, changedDatabase);
      const migrate = (maintenance: OpenClawStateLeaseContext) =>
        migrateAgentDb(f.options, maintenance);
      const work = changedDatabase
        ? withMaintenance({ env: f.env }, migrate)
        : withAbortableMaintenance(f, abort.signal, migrate);
      await expect(work).rejects.toThrow(
        loss === "owner"
          ? /belongs to agent other-agent/
          : loss === "version"
            ? /newer schema/
            : /lost|abort/i,
      );
      expect(spy).toHaveBeenCalledOnce();
      expect(readIndexState(f.options.pathname)).toEqual(before);
      if (loss === "replacement") {
        expect(f.owners()).toEqual([{ owner: "successor" }]);
      }
    },
  );

  it("joins a cancelled real Worker before closing its database or releasing the fence", async () => {
    const f = fixture();
    const abort = new AbortController();
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    const open = sqlite.openNodeSqliteDatabase;
    let completed = false;
    let native: Promise<void> | undefined;
    vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
      const database = open(pathname, options);
      if (pathname === f.options.pathname && options?.readOnly !== true) {
        const close = database.close.bind(database);
        database.close = () => {
          try {
            expect(completed).toBe(true);
          } finally {
            close();
          }
        };
      }
      return database;
    });
    vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation((...args) => {
      native = check(...args).finally(() => {
        completed = true;
      });
      abort.abort(new Error("synthetic maintenance abort"));
      expect(completed).toBe(false);
      expect(f.owners()).toHaveLength(1);
      return native;
    });
    try {
      await expect(
        withAbortableMaintenance(f, abort.signal, (maintenance) =>
          migrateAgentDb(f.options, maintenance),
        ),
      ).rejects.toThrow(/abort/i);
      expect(completed).toBe(true);
      expect(f.owners()).toEqual([]);
    } finally {
      await native?.catch(() => {});
    }
  });

  it.each(["closed", "outside", "copied"] as const)(
    "requires the exact active maintenance scope when its context is %s",
    async (scope) => {
      const f = fixture();
      const scan = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
      const reject = async (maintenance: OpenClawStateLeaseContext) => {
        const open = vi.spyOn(sqlite, "openNodeSqliteDatabase");
        await expect(migrateAgentDb(f.options, maintenance)).rejects.toThrow(
          /stopped-writer maintenance/,
        );
        expect(open).not.toHaveBeenCalled();
        expect(scan).not.toHaveBeenCalled();
      };
      if (scope === "closed") {
        const retained = await withMaintenance({ env: f.env }, async (maintenance) => maintenance);
        expect(retained).toBeDefined();
        scan.mockClear();
        await reject(retained);
      } else if (scope === "copied") {
        await withMaintenance({ env: f.env }, (maintenance) => reject({ ...maintenance }));
      } else {
        const ready = createDeferred<OpenClawStateLeaseContext>();
        const release = createDeferred();
        const running = withMaintenance({ env: f.env }, async (maintenance) => {
          ready.resolve(maintenance);
          await release.promise;
        });
        try {
          const maintenance = await ready.promise;
          maintenance.assertOwned();
          await reject(maintenance);
        } finally {
          release.resolve();
          await running;
        }
      }
      expect(scan).not.toHaveBeenCalled();
    },
  );
});

it.each(["quick", "full", "unspecified", "no-scope"] as const)(
  "preserves %s integrity coverage when draining a real maintenance lease",
  async (mode) => {
    const { env, options, state } = fixture();
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: options.agentId,
      path: options.pathname,
      env,
    });
    await withOpenClawStateLease(
      {
        ...leaseOptions(env),
        leaseMs: 30_000,
        waitMs: 0,
      },
      (authority) =>
        withMaintenanceAuthority(authority, state.path, async () => {
          const scope =
            mode === "no-scope"
              ? undefined
              : createOpenClawDatabaseMaintenanceScope({
                  sqliteIntegrityCheck: mode === "unspecified" ? undefined : mode,
                  assertDatabaseAccess: (pathname) => expect(pathname).toBe(state.path),
                });
          const release = () => releaseAgentLease(leaseId, { env }, "read-only");
          scope?.own({}, "agent-resources", release);
          // Exercise cleanup without borrowing the fixture's earlier FULL admission.
          revokeSqliteDatabaseAdmissionsForPath(state.path);
          const reads = observeSqliteReadSql(StatementSync.prototype);
          try {
            if (scope) {
              await scope.close();
            } else {
              release();
            }
            if (mode === "quick") {
              expect(reads.queries).toContain("PRAGMA quick_check;");
              for (const table of ["schema_meta", "state_leases", "agent_database_leases"]) {
                expect(reads.queries).toContain(`PRAGMA integrity_check('${table}');`);
              }
              expect(reads.queries).not.toContain("PRAGMA integrity_check;");
            } else {
              expect(reads.queries).not.toContain("PRAGMA quick_check;");
              expect(
                reads.queries.filter((query) => query === "PRAGMA integrity_check;"),
              ).toHaveLength(1);
            }
            expect(state.db.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual(
              [],
            );
          } finally {
            reads.restore();
            await scope?.close();
          }
        }),
    );
  },
);

it.for(["journal replaced", "lease expired"] as const)(
  "preserves legacy storage when deletion authority is %s after real integrity admission",
  (loss, { signal }) =>
    withOpenClawTestState({ label: "deletion-schema-authority" }, async (state) => {
      openOpenClawStateDatabase({ env: state.env });
      const databasePath = path.join(state.agentDir("worker"), "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      {
        using database = new DatabaseSync(databasePath);
        seedLegacyAgentFixture(database, "worker");
      }
      registerOpenClawAgentDatabase({
        agentId: "worker",
        path: databasePath,
        schemaVersion: 24,
        env: state.env,
      });
      const original = fs.readFileSync(databasePath);
      const statePath = resolveOpenClawStateSqlitePath(state.env);
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      let interrupted = false;
      let clock: { mockRestore(): void } | undefined;
      const scan = vi
        .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
        .mockImplementationOnce(async (...args) => {
          await check(...args);
          signal.throwIfAborted();
          interrupted = true;
          if (loss === "lease expired") {
            // Expire deletion's 60s grant while the separate maintenance grant stays live.
            clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
            return;
          }
          using foreign = new DatabaseSync(statePath);
          const mutation = foreign
            .prepare(
              "UPDATE agent_deletion_journal SET operation_id = 'replacement' WHERE agent_id = 'worker'",
            )
            .run();
          expect(mutation.changes).toBe(1);
        });
      try {
        const failure: unknown = await withAgentDeletion(
          "worker",
          async (begin) => {
            const deletion = await begin({
              agentId: "worker",
              agentDir: state.agentDir("worker"),
              workspaceDir: state.workspaceDir,
              sessionsDir: state.sessionsDir("worker"),
              deleteFiles: false,
              phase: "retiring",
            });
            await withMaintenance({ env: state.env, leaseMs: 120_000 }, (maintenance) =>
              deletion.runDatabaseCleanup({ agentId: "worker", path: databasePath }, () =>
                migrateAgentDb(
                  { agentId: "worker", pathname: databasePath, env: state.env, register: true },
                  maintenance,
                ),
              ),
            );
          },
          { env: state.env },
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(interrupted, String(failure)).toBe(true);
        expect(String(failure)).toMatch(
          /no longer owns database cleanup|core:agent-deletion\/worker.*was lost/,
        );
        expect(scan).toHaveBeenCalledOnce();
      } finally {
        scan.mockRestore();
        clock?.mockRestore();
        await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      }
      expect(fs.readFileSync(databasePath)).toEqual(original);
      using legacy = new DatabaseSync(databasePath, { readOnly: true });
      expect(legacy.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
      expect(legacy.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      using shared = new DatabaseSync(statePath, { readOnly: true });
      expect(
        shared
          .prepare(`SELECT schema_version, cleanup_completed FROM agent_databases
        JOIN agent_deletion_journal USING (agent_id) WHERE agent_id = 'worker'`)
          .all(),
      ).toEqual([{ schema_version: 24, cleanup_completed: 0 }]);
    }),
);
