import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { copyFileSync, existsSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureConfigHealthStateStore } from "../config/io.health-state.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import { readClientCredentialFileIdentity } from "../infra/client-credential-receipt.js";
import { rebindRehearsalClientCredentials } from "../infra/client-credential-restore.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import {
  captureSqliteWorkerStateContext,
  runWithSqliteWorkerStateContext,
} from "../infra/sqlite-worker-state-context.js";
import { NodeWorkerPreparedWorkspaceStore } from "../node-host/node-worker-prepared-workspace-store.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { writeConfigMachineState } from "./config-machine-state-write.js";
import { readConfigMachineState } from "./config-machine-state.js";
import { createOpenClawStateDatabaseAsyncLifecycle } from "./openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { openTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { markCurrentStateSchemaVersion } from "./openclaw-state-db-maintenance.js";
import {
  closeRetainedOpenClawStateReadConnections,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import {
  assertExistingOpenClawStateSchemaCacheAdmission,
  getExistingOpenClawStateSchemaPath,
  withExistingOpenClawStateSchema,
} from "./openclaw-state-db-schema-policy.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import { runManagedStateTransaction } from "./openclaw-state-db-transaction.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  initializeNativeOpenClawStateDatabase,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseReadabilityForDoctor,
  repairOpenClawStateDatabaseSchema,
  prepareOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
  runWithOpenClawStateBusyTimeout,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "./openclaw-state-db.js";
import { captureOpenClawStateReadWorkerContextWithAdmission } from "./openclaw-state-worker-context.capture.js";
import { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const previousAppVersion = "synthetic-previous-build";
const previousVersion = OPENCLAW_STATE_SCHEMA_VERSION - 1;

function observeReads() {
  const observation = observeSqliteReadSql(StatementSync.prototype);
  return {
    ...observation,
    count: (...patterns: RegExp[]) =>
      observation.queries.filter((sql) => patterns.every((pattern) => pattern.test(sql))).length,
    [Symbol.dispose]: () => observation.restore(),
  };
}

function readSchemaState(db: EngineConnection) {
  return {
    version: db.prepare("PRAGMA user_version").get(),
    metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    content: db
      .prepare("SELECT * FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'")
      .get(),
  };
}

function readMeta(db: EngineConnection, column: "app_version" | "schema_version") {
  return db.prepare(`SELECT ${column} FROM schema_meta WHERE meta_key = 'primary'`).get();
}

function readPersistedSchema(pathname: string) {
  using db = new DatabaseSync(pathname, { readOnly: true });
  return {
    ...readSchemaState(db),
    schema: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(),
  };
}

function createExistingState(mutate?: (db: DatabaseSync) => void) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-existing-schema-") };
  const pathname = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabase();
  const sourceSharedFile = readClientCredentialFileIdentity(pathname);
  assert(sourceSharedFile);
  const seedPath = `${pathname}.seed`;
  renameSync(pathname, seedPath);
  copyFileSync(seedPath, pathname);
  try {
    using db = new DatabaseSync(pathname);
    db.prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'").run(
      previousAppVersion,
    );
    db.exec(`
      INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
        VALUES ('startup-migrations', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL,
                'synthetic-startup-checkpoint', 10, 20);
    `);
    mutate?.(db);
    return { options: { env, path: pathname }, before: readSchemaState(db), sourceSharedFile };
  } finally {
    // Model bytes from an earlier process, not a raw edit of this process's admitted inode.
    const replacement = `${pathname}.fixture`;
    copyFileSync(pathname, replacement);
    renameSync(replacement, pathname);
  }
}

function insertForeignKeyCorruption(db: DatabaseSync) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO acp_replay_events
      (session_id, seq, at, session_key, run_id, update_json, estimated_bytes)
      VALUES ('missing-session', 1, 10, 'session', NULL, '{}', 0);
  `);
}

function createPreviousState() {
  return createExistingState((database) => {
    database.exec(`PRAGMA user_version = ${previousVersion};
      UPDATE schema_meta SET schema_version = ${previousVersion} WHERE meta_key = 'primary';`);
  });
}

describe("ordinary shared-state reader admission", () => {
  it("skips handle inventories before restricted admission while honoring expired scopes", async () => {
    const pathname = path.join(tempDirs.make("openclaw-schema-policy-"), "state.sqlite");
    const inventory = {
      cachedDatabases: new Map<string, { db: EngineConnection }>(),
      retainedDatabaseHandles: new Map<EngineConnection, { db: EngineConnection }>(),
    };
    const check = () => assertExistingOpenClawStateSchemaCacheAdmission(pathname, inventory);
    {
      using realpath = vi.spyOn(realpathSync, "native");
      using scans = vi.spyOn(Map.prototype, "values");
      for (let index = 0; index < 100; index++) {
        check();
      }
      expect(scans.mock.calls.length).toBe(0);
      expect(realpath).not.toHaveBeenCalled();
    }
    const expired = await withExistingOpenClawStateSchema({ path: pathname }, async () =>
      AsyncLocalStorage.bind(check),
    );
    expect(expired).toThrow("Existing shared-state schema admission has ended");
  });

  it("reuses cold schema facts without adding a warm freshness probe", () => {
    const { options } = createExistingState();
    const read = () =>
      withOpenClawStateReadOnlyLocation(
        ({ db }) => readMeta(db, "app_version"),
        options.path,
        options.path,
        undefined,
        undefined,
        undefined,
        true,
      );
    using cleanup = new DisposableStack();
    cleanup.defer(closeRetainedOpenClawStateReadConnections);
    using reads = observeReads();
    expect(read()).toEqual({ app_version: previousAppVersion });
    const coldVersionReads = reads.count(/^PRAGMA user_version\b/iu);
    const coldContentReads = reads.count(/\bconfig_machine_state\b/iu);
    reads.queries.length = 0;
    expect(read()).toEqual({ app_version: previousAppVersion });
    expect({
      coldPublishedVersion: coldVersionReads,
      coldContentVersion: coldContentReads,
      warmPublishedVersion: reads.count(/^PRAGMA user_version\b/iu),
      warmContentVersion: reads.count(/\bconfig_machine_state\b/iu),
      warmFreshness: reads.count(
        /(?:^PRAGMA data_version\b|\bFROM main\.pragma_data_version\(\))/iu,
      ),
    }).toEqual({
      coldPublishedVersion: 1,
      coldContentVersion: 1,
      warmPublishedVersion: 0,
      warmContentVersion: 0,
      warmFreshness: 0,
    });
  });

  it("observes an owned migration committed during first reader admission", () => {
    const { options } = createPreviousState();
    using peer = openTrackedStateDatabase(options.path);
    let upgraded = false;
    // oxlint-disable-next-line typescript/unbound-method -- The proxy retains the native statement receiver.
    const nativeGet = StatementSync.prototype.get;
    using observer = vi.spyOn(StatementSync.prototype, "get");
    observer.mockImplementation(
      new Proxy(nativeGet, {
        apply(target, receiver: StatementSync, args) {
          const publishedVersion = /^PRAGMA user_version\b/iu.test(receiver.sourceSQL);
          const result = Reflect.apply(target, receiver, args);
          if (publishedVersion && !upgraded) {
            upgraded = true;
            runManagedStateTransaction(peer, () => markCurrentStateSchemaVersion(peer), {
              operationLabel: "state.version.admission.fixture",
            });
          }
          return result;
        },
      }),
    );
    const read = vi.fn(({ db }: { db: EngineConnection }) => ({
      version: readStateSchemaContentVersion(db),
      metadata: readMeta(db, "schema_version"),
    }));
    expect(withOpenClawStateReadOnlyLocation(read, options.path, options.path)).toEqual({
      version: OPENCLAW_STATE_SCHEMA_VERSION,
      metadata: { schema_version: OPENCLAW_STATE_SCHEMA_VERSION },
    });
    expect(upgraded).toBe(true);
    expect(read).toHaveBeenCalledOnce();
  });

  it("publishes migration-owned content versions across rollback and sibling settlement", () => {
    const { options } = createPreviousState();
    using db = openTrackedStateDatabase(options.path);
    using peer = openTrackedStateDatabase(options.path);
    const read = () => runSqliteReadOperationSync(db, () => readStateSchemaContentVersion(db));
    admitSqliteSchema(db);
    expect(read()).toBe(previousVersion);
    expect(() =>
      runManagedStateTransaction(
        db,
        () => {
          markCurrentStateSchemaVersion(db);
          expect(read()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
          throw new Error("synthetic version rollback");
        },
        { operationLabel: "state.version.rollback.fixture" },
      ),
    ).toThrow("synthetic version rollback");
    expect(read()).toBe(previousVersion);
    runManagedStateTransaction(peer, () => markCurrentStateSchemaVersion(peer), {
      operationLabel: "state.version.publish.fixture",
    });
    expect(read()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    db.exec("DROP TABLE config_machine_state");
    expect(read()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function").each([false, true])(
    "rechecks content-marker authorization after a successful read (admitted=%s)",
    (admitted) => {
      const { options } = createExistingState();
      using db = openTrackedStateDatabase(options.path);
      const read = () => runSqliteReadOperationSync(db, () => readStateSchemaContentVersion(db));
      if (admitted) {
        admitSqliteSchema(db);
      }
      expect(read()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      let allow = true;
      db.setAuthorizer((action, table) =>
        !allow && action === constants.SQLITE_READ && table === "config_machine_state"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      expect(read()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      allow = false;
      expect(read).toThrow(/not authorized|prohibited/iu);
      allow = true;
      expect(read()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    },
  );
});

describe("existing shared-state schema admission", () => {
  it.each(["ordinary", "required", "existing"] as const)(
    "checks read-only integrity once per %s admission and refuses later corruption",
    async (policy) => {
      const { options, before } = createExistingState();
      const open = () => {
        const read = () =>
          openExistingOpenClawStateDatabaseReadOnly({
            ...options,
            requireCanonicalSchema: policy === "required",
          });
        return policy === "existing" ? withExistingOpenClawStateSchema(options, read) : read();
      };
      {
        using reads = observeReads();
        const database = await open();
        assert(database);
        using cleanup = new DisposableStack();
        cleanup.defer(() => database.walMaintenance.close());
        expect(reads.count(/^PRAGMA integrity_check\b/iu)).toBe(1);
        expect(reads.count(/^PRAGMA foreign_key_check\b/iu)).toBe(1);
        expect(readSchemaState(database.db)).toEqual(before);
      }

      {
        using corrupted = new DatabaseSync(options.path);
        insertForeignKeyCorruption(corrupted);
      }
      await expect(open()).rejects.toThrow(/foreign_key_check/i);
    },
  );

  it.each(["schema rollback", "canonical close", "replacement"] as const)(
    "shares physical integrity proof through %s and validates replacement files",
    async (change) => {
      const replacement =
        change === "replacement" ? createExistingState(insertForeignKeyCorruption) : undefined;
      const { options, before } = createExistingState();
      await withExistingOpenClawStateSchema(options, async () => {
        using sibling = openTrackedStateDatabase(options.path, { readOnly: true });
        admitSqliteSchema(sibling);
        const capture = () =>
          captureSqliteWorkerStateContext(captureOpenClawStateReadWorkerContext(options));
        const context = capture();
        const read = (source = context) =>
          runWithSqliteWorkerStateContext(structuredClone(source), () =>
            withOpenClawStateReadOnlyLocation(
              ({ db }) => readSchemaState(db),
              options.path,
              options.path,
            ),
          );
        using reads = observeReads();
        const checkCount = () => reads.count(/^PRAGMA integrity_check\b/iu);
        expect(read()).toEqual(before);
        expect(read()).toEqual(before);
        expect(checkCount()).toBe(1);
        expect(reads.count(/^PRAGMA foreign_key_check\b/iu)).toBe(1);
        if (change === "schema rollback") {
          const database = openOpenClawStateDatabase(options);
          const cookie = database.db.prepare("PRAGMA schema_version").get();
          database.db.exec("BEGIN; CREATE TABLE runtime_admission_probe (id INTEGER); ROLLBACK");
          expect(database.db.prepare("PRAGMA schema_version").get()).toEqual(cookie);
          const fresh = capture();
          expect(read(fresh)).toEqual(before);
          expect(read(fresh)).toEqual(before);
          expect(checkCount()).toBe(1);
          expect(read()).toEqual(before);
        } else if (replacement) {
          renameSync(options.path, `${options.path}.previous`);
          copyFileSync(replacement.options.path, options.path);
          expect(() => read()).toThrow(/foreign_key_check/i);
        } else {
          sibling.close();
          await closeOpenClawStateDatabaseAsync();
          expect(read(capture())).toEqual(before);
        }
        expect(checkCount()).toBe(change === "replacement" ? 2 : 1);
      });
    },
  );

  it.each(["managed commit", "managed rollback", "raw rollback"] as const)(
    "publishes shared integrity proof only after outer transaction settlement (%s)",
    (settlement) => {
      const { options, before } = createExistingState();
      withExistingOpenClawStateSchema(options, () => {
        const context = captureSqliteWorkerStateContext(
          captureOpenClawStateReadWorkerContext(options),
        );
        using database = openTrackedStateDatabase(options.path);
        using reads = observeReads();
        const admit = () =>
          assertExistingOpenClawStateRuntimeSchema(database, options.path, context.stateIntegrity);
        if (settlement === "raw rollback") {
          database.exec("BEGIN");
          admit();
          database.exec("ROLLBACK");
        } else {
          const run = () =>
            runManagedStateTransaction(
              database,
              () => {
                admit();
                if (settlement === "managed rollback") {
                  throw new Error("synthetic rollback");
                }
              },
              { operationLabel: "state.admission.fixture" },
            );
          if (settlement === "managed rollback") {
            expect(run).toThrow("synthetic rollback");
          } else {
            run();
          }
        }
        const result = runWithSqliteWorkerStateContext(structuredClone(context), () =>
          withOpenClawStateReadOnlyLocation(
            ({ db }) => readSchemaState(db),
            options.path,
            options.path,
          ),
        );
        expect(result).toEqual(before);
        expect(reads.count(/^PRAGMA integrity_check\b/iu)).toBe(
          settlement === "managed commit" ? 1 : 2,
        );
      });
    },
  );

  it.each(["reader", "writer", "closed reader", "module graph"] as const)(
    "revokes transported integrity proof after %s corruption",
    async (kind) => {
      const { options, before } = createExistingState();
      const host = createOpenClawStateDatabaseAsyncLifecycle();
      await withExistingOpenClawStateSchema(options, async () => {
        using sibling = openTrackedStateDatabase(options.path, { readOnly: true });
        admitSqliteSchema(sibling);
        const context = captureSqliteWorkerStateContext(
          captureOpenClawStateReadWorkerContextWithAdmission(
            options,
            host.capture,
            host.knownIdentity,
          ),
        );
        const lifetime = context.stateIntegrity?.lifetime;
        assert(lifetime);
        const run = <T>(operation: () => T) =>
          runWithSqliteWorkerStateContext(structuredClone(context), operation);
        const read = () =>
          run(() =>
            withOpenClawStateReadOnlyLocation(
              ({ db }) => readSchemaState(db),
              options.path,
              options.path,
            ),
          );
        using reads = observeReads();
        expect(read()).toEqual(before);
        expect(read()).toEqual(before);
        expect(Atomics.load(new BigInt64Array(lifetime.revision), 0)).toBe(lifetime.epoch);
        expect(reads.count(/^PRAGMA integrity_check\b/iu)).toBe(1);
        const corruption = Object.assign(new Error("synthetic SQLite corruption"), {
          errcode: 11,
        });
        if (kind === "module graph") {
          const database = run(() => openOpenClawStateDatabase(options));
          vi.resetModules();
          const { openClawStateDatabaseCache } = await import("./openclaw-state-db-cache.js");
          expect(
            openClawStateDatabaseCache.evictOpenClawStateDatabaseAfterCorruption(
              database,
              corruption,
            ),
          ).toBe(true);
        } else {
          expect(() =>
            run(() => {
              if (kind !== "writer") {
                return withOpenClawStateReadOnlyLocation(
                  ({ db }) => {
                    if (kind === "closed reader") {
                      db.close();
                    }
                    throw corruption;
                  },
                  options.path,
                  options.path,
                );
              }
              return runOpenClawStateWriteTransaction(() => {
                throw corruption;
              }, options);
            }),
          ).toThrow(corruption);
        }
        expect(Atomics.load(new BigInt64Array(lifetime.revision), 0)).not.toBe(lifetime.epoch);
        {
          using db = new DatabaseSync(options.path);
          insertForeignKeyCorruption(db);
        }
        expect(read).toThrow(/foreign_key_check/i);
      });
    },
  );

  it("refuses pre-July agent registry primary keys without migrating them", () => {
    const { options } = createExistingState((db) => {
      db.exec(`
        DROP TABLE agent_databases;
        CREATE TABLE agent_databases (
          agent_id TEXT NOT NULL PRIMARY KEY,
          path TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          size_bytes INTEGER
        );
        INSERT INTO agent_databases VALUES ('main', 'legacy.sqlite', 1, 10, 20);
      `);
    });
    const before = readPersistedSchema(options.path);
    expect(() => openOpenClawStateDatabase(options)).toThrow(
      "Upgrades from pre-July-2026 state are no longer migrated",
    );
    expect(repairOpenClawStateDatabaseSchema(options)).toMatchObject({
      changes: [],
      warnings: [expect.stringContaining("unsupported agent database registry schema")],
    });
    expect(readPersistedSchema(options.path)).toEqual(before);
    using preserved = new DatabaseSync(options.path, { readOnly: true });
    expect(preserved.prepare("SELECT * FROM agent_databases").all()).toEqual([
      {
        agent_id: "main",
        path: "legacy.sqlite",
        schema_version: 1,
        last_seen_at: 10,
        size_bytes: 20,
      },
    ]);
  });

  it.each(["transaction", "implicit pin"] as const)(
    "observes an owned migration after its %s read snapshot ends",
    (snapshot) => {
      const { options } = createPreviousState();
      using db = openTrackedStateDatabase(options.path);
      using peer = openTrackedStateDatabase(options.path);
      admitSqliteSchema(db);
      const read = () => runSqliteReadOperationSync(db, () => readStateSchemaContentVersion(db));
      expect(read()).toBe(previousVersion);
      const reads = observeReads();
      const readSnapshot = () => {
        expect(readMeta(db, "schema_version")).toEqual({ schema_version: previousVersion });
        expect(read()).toBe(previousVersion);
        runManagedStateTransaction(peer, () => markCurrentStateSchemaVersion(peer), {
          operationLabel: "state.version.snapshot.fixture",
        });
        expect(read()).toBe(previousVersion);
        expect(readMeta(db, "schema_version")).toEqual({ schema_version: previousVersion });
      };
      try {
        if (snapshot === "transaction") {
          db.exec("BEGIN");
          readSnapshot();
          db.exec("COMMIT");
        } else {
          runSqliteSchemaReadSnapshotSync(db, readSnapshot);
        }
        expect(read()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
        expect(readMeta(db, "schema_version")).toEqual({
          schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
        });
        expect(reads.count(/data_version/iu)).toBe(0);
      } finally {
        reads.restore();
        if (db.isTransaction) {
          db.exec("ROLLBACK");
        }
      }
    },
  );

  it("writes node state and initializes its lazy store without taking over release repair", async () => {
    const { options, before, sourceSharedFile } = createExistingState((db) => {
      db.exec(`
        PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
        UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}
          WHERE meta_key = 'primary';
        INSERT INTO config_machine_state VALUES
          ('state.schema.contentVersion', '${OPENCLAW_STATE_SCHEMA_VERSION}', 30);
        INSERT INTO acp_replay_sessions
          (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes)
          VALUES ('retained', 'session', '/workspace', 1, 10, 20, 1, 0);
      `);
    });

    rebindRehearsalClientCredentials({
      sourceSharedFile,
      sourceStateRoot: options.env.OPENCLAW_STATE_DIR,
      sharedPath: options.path,
      localPath: resolveClientCredentialStorePath(options.env),
    });

    await withExistingOpenClawStateSchema(options, async () => {
      writeConfigMachineState("node.schema-policy-probe", { nodeId: "paired-node" }, options);
      const database = openOpenClawStateDatabase(options);
      expect(
        database.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'node_worker_prepared_workspaces'")
          .get(),
      ).toBeUndefined();
      const store = new NodeWorkerPreparedWorkspaceStore(options);
      const registered = await store.register({
        action: "register",
        gatewayNamespace: "test-gateway",
        environmentId: "test-environment",
        preparationKey: "a".repeat(64),
        cacheKey: "b".repeat(64),
        workspaceDir: "/workspace",
        homeDir: "/home/node",
        sourceManifestRef: `sha256:${"c".repeat(64)}`,
        preparedManifestRef: `sha256:${"d".repeat(64)}`,
      });
      expect(await store.find("test-environment")).toEqual(registered);
      expect(readConfigMachineState("node.schema-policy-probe", options)).toEqual({
        nodeId: "paired-node",
      });
      expect(readSchemaState(database.db)).toEqual(before);
      expect(database.db.prepare("SELECT estimated_bytes FROM acp_replay_sessions").get()).toEqual({
        estimated_bytes: 0,
      });
    });

    await closeOpenClawStateDatabaseAsync();
    const reopened = openOpenClawStateDatabase(options);
    expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(readMeta(reopened.db, "app_version")).toEqual({ app_version: previousAppVersion });
    expect(
      reopened.db.prepare("SELECT estimated_bytes FROM acp_replay_sessions").get()?.estimated_bytes,
    ).toBe(0);
    expect(readConfigMachineState("node.schema-policy-probe", options)).toEqual({
      nodeId: "paired-node",
    });
    expect(
      await new NodeWorkerPreparedWorkspaceStore(options).find("test-environment"),
    ).toMatchObject({
      preparation_key: "a".repeat(64),
      state: "available",
    });

    await closeOpenClawStateDatabaseAsync();
    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
    const repaired = openOpenClawStateDatabase(options);
    expect(readMeta(repaired.db, "app_version")).toEqual({ app_version: previousAppVersion });
    expect(
      repaired.db.prepare("SELECT estimated_bytes FROM acp_replay_sessions").get()?.estimated_bytes,
    ).toBeGreaterThan(0);
  });

  it("does not create a missing database or its parent directory", () => {
    const stateDir = tempDirs.make("openclaw-missing-existing-schema-");
    const options = {
      path: path.join(stateDir, "missing", "openclaw.sqlite"),
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    expect(() =>
      withExistingOpenClawStateSchema(options, () => openOpenClawStateDatabase(options)),
    ).toThrow(/ENOENT|existing|unable to open/i);
    expect(existsSync(path.dirname(options.path))).toBe(false);
  });

  it.each([
    {
      name: "forward migration by a newer CLI than the managed service",
      sql: `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
            UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}
              WHERE meta_key = 'primary';`,
      serviceVersion: "2026.10.3",
      expectedError:
        /this CLI is 2026\.10\.8 but the Gateway service runs 2026\.10\.3.*run openclaw update/u,
    },
    {
      name: "older migration content",
      sql: `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
            UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}
              WHERE meta_key = 'primary';`,
    },
    {
      name: "newer published schema",
      sql: `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
            UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}
              WHERE meta_key = 'primary';`,
    },
    {
      name: "mismatched published metadata",
      sql: "UPDATE schema_meta SET schema_version = schema_version - 1 WHERE meta_key = 'primary';",
    },
    {
      name: "non-global ownership",
      sql: "UPDATE schema_meta SET role = 'agent', agent_id = 'main' WHERE meta_key = 'primary';",
    },
    {
      name: "missing metadata role column",
      sql: "ALTER TABLE schema_meta RENAME COLUMN role TO retired_role;",
      expectedError: SqliteSchemaMismatchError,
    },
    {
      name: "missing startup column",
      sql: "ALTER TABLE worker_environments DROP COLUMN preparation_purpose;",
    },
    {
      name: "missing startup table",
      sql: "DROP TABLE worker_session_tool_operations;",
    },
    {
      name: "drifted canonical index",
      sql: `DROP INDEX idx_plugin_state_listing;
            CREATE INDEX idx_plugin_state_listing
              ON plugin_state_entries(plugin_id, namespace, created_at, entry_key);`,
    },
    {
      name: "retired cron history",
      sql: `CREATE TABLE cron_run_logs (
              store_key TEXT NOT NULL, job_id TEXT NOT NULL,
              seq INTEGER NOT NULL, ts INTEGER NOT NULL,
              PRIMARY KEY (store_key, job_id, seq)
            );`,
    },
    {
      name: "incompatible existing lazy table",
      sql: "CREATE TABLE node_worker_prepared_workspaces (preparation_key INTEGER PRIMARY KEY) STRICT;",
    },
    {
      name: "foreign-key corruption",
      sql: `PRAGMA foreign_keys = OFF;
            INSERT INTO acp_replay_events
              (session_id, seq, at, session_key, run_id, update_json, estimated_bytes)
              VALUES ('missing-session', 1, 10, 'session', NULL, '{}', 0);`,
    },
  ])(
    "refuses $name without migrating or repairing the file",
    async ({ sql, serviceVersion, expectedError = /schema|foreign_key_check/i }) => {
      const { options } = createExistingState((db) => db.exec(sql));
      const before = readPersistedSchema(options.path);
      if (serviceVersion) {
        assert(expectedError instanceof RegExp);
        const context = {
          environment: options.env,
          gatewayServiceInstallation: {
            root: "/fixture/old-install",
            version: serviceVersion,
            cliVersion: "2026.10.8",
            databasePath: options.path,
          },
        };
        const refusal = await runWithSqliteWorkerStateContext(context, async () => {
          const health = captureConfigHealthStateStore(
            {
              env: options.env,
              homedir: () => options.env.OPENCLAW_STATE_DIR,
              logger: console,
            },
            path.join(options.env.OPENCLAW_STATE_DIR, "openclaw.json"),
          );
          await health.update(
            { lastObservedSuspiciousSignature: "skew" },
            { state: {}, basis: null },
          );
        }).catch((error: unknown) => error);
        expect(readPersistedSchema(options.path)).toEqual(before);
        expect(refusal).toMatchObject({ message: expect.stringMatching(expectedError) });
      } else {
        expect(() =>
          withExistingOpenClawStateSchema(options, () => openOpenClawStateDatabase(options)),
        ).toThrow(expectedError);
      }
      expect(readPersistedSchema(options.path)).toEqual(before);
    },
  );

  it("refuses global repair and startup-checkpoint entry points inside the node scope", async () => {
    const { options, before } = createExistingState();
    await withExistingOpenClawStateSchema(options, async () => {
      for (const run of [
        () => repairOpenClawStateDatabaseSchema(options),
        () => repairOpenClawStateDatabaseReadabilityForDoctor(options),
        () => initializeNativeOpenClawStateDatabase(options),
        () => withOpenClawStateStartupMigrationCheckpointDatabase(() => "checkpoint", options),
      ]) {
        expect(run).toThrow(/schema repair.*owned/i);
      }
      await expect(prepareOpenClawStateDatabaseSchema(options)).rejects.toThrow(
        /schema repair.*owned/i,
      );
    });
    expect(readPersistedSchema(options.path)).toMatchObject(before);
  });

  it("does not let restricted cached or supplied handles escape to ordinary admission", () => {
    const { options, before } = createExistingState();
    const database = withExistingOpenClawStateSchema(options, () =>
      openOpenClawStateDatabase(options),
    );
    for (const ordinaryOptions of [options, { ...options, database }]) {
      expect(() => openOpenClawStateDatabase(ordinaryOptions)).toThrow(/without schema repair/i);
      expect(() => runOpenClawStateWriteTransaction(() => "must not run", ordinaryOptions)).toThrow(
        /without schema repair/i,
      );
      expect(() =>
        runWithOpenClawStateBusyTimeout(() => "must not run", ordinaryOptions, 0),
      ).toThrow(/without schema repair/i);
    }
    expect(database.db.isOpen).toBe(true);
    expect(readSchemaState(database.db)).toEqual(before);
  });

  it.skipIf(process.platform === "win32")(
    "refuses ordinary admission through an alias until the restricted handle closes",
    () => {
      const { options, before } = createExistingState();
      const aliasOptions = {
        ...options,
        path: path.join(path.dirname(options.path), "alias.sqlite"),
      };
      symlinkSync(options.path, aliasOptions.path, "file");
      const database = withExistingOpenClawStateSchema(options, () =>
        openOpenClawStateDatabase(options),
      );

      expect(() => openOpenClawStateDatabase(aliasOptions)).toThrow(/without schema repair/i);
      expect(database.db.isOpen).toBe(true);
      expect(readSchemaState(database.db)).toEqual(before);
      withExistingOpenClawStateSchema(aliasOptions, () => {
        expect(getExistingOpenClawStateSchemaPath()).toBe(aliasOptions.path);
        expect(openOpenClawStateDatabase(options)).toBe(database);
      });

      closeOpenClawStateDatabase();
      expect(database.db.isOpen).toBe(false);
      const reopened = openOpenClawStateDatabase(aliasOptions);
      expect(readMeta(reopened.db, "app_version")).toEqual({ app_version: previousAppVersion });
    },
  );

  it("inspects schema indexes once and observes managed same-version changes before handle reuse", () => {
    const { options } = createExistingState();
    using reads = observeReads();
    withExistingOpenClawStateSchema(options, () => {
      const database = openOpenClawStateDatabase(options);
      expect(reads.count(/index_xinfo/, /idx_plugin_state_listing/)).toBeLessThanOrEqual(1);
      {
        using external = openTrackedStateDatabase(options.path);
        external.exec("ALTER TABLE worker_environments DROP COLUMN preparation_purpose");
      }
      expect(() => openOpenClawStateDatabase(options)).toThrow(/schema|repair/i);
      expect(() =>
        writeConfigMachineState("node.incompatible", true, { ...options, database }),
      ).toThrow(/schema|repair/i);
      expect(() => runWithOpenClawStateBusyTimeout(() => "must not run", options, 0)).toThrow(
        /schema|repair/i,
      );
      expect(
        database.db
          .prepare(
            "SELECT state_key FROM config_machine_state WHERE state_key = 'node.incompatible'",
          )
          .get(),
      ).toBeUndefined();
    });
  });

  it("does not reuse validation from a rolled-back schema transaction", () => {
    const { options } = createExistingState();
    withExistingOpenClawStateSchema(options, () => {
      const database = openOpenClawStateDatabase(options);
      database.db.exec("BEGIN; CREATE TABLE temporary_shape (id INTEGER)");
      try {
        const cookie = database.db.prepare("PRAGMA schema_version").get()?.schema_version;
        expect(openOpenClawStateDatabase(options)).toBe(database);
        database.db.exec("ROLLBACK; DROP INDEX idx_plugin_state_listing");
        expect(database.db.prepare("PRAGMA schema_version").get()?.schema_version).toBe(cookie);
        expect(() => openOpenClawStateDatabase(options)).toThrow(/schema|repair/i);
      } finally {
        if (database.db.isTransaction) {
          database.db.exec("ROLLBACK");
        }
      }
    });
  });

  it.each(["close", "dispose"] as const)(
    "revalidates a schema cookie after native %s and same-object reopen",
    (action) => {
      const { options } = createExistingState();
      // Allow this fixture to reuse the native cookie across different schema generations.
      using database = new DatabaseSync(options.path, { defensive: false });
      assertExistingOpenClawStateRuntimeSchema(database, options.path);
      const cookie = database.prepare("PRAGMA schema_version").get()?.schema_version;
      assert(typeof cookie === "number");
      if (action === "close") {
        database.close();
      } else {
        database[Symbol.dispose]();
      }
      database.open();
      database.exec(`DROP INDEX idx_plugin_state_listing; PRAGMA schema_version = ${cookie}`);
      expect(database.prepare("PRAGMA schema_version").get()?.schema_version).toBe(cookie);
      expect(() => assertExistingOpenClawStateRuntimeSchema(database, options.path)).toThrow(
        /idx_plugin_state_listing/,
      );
    },
  );

  it("refuses admission when SQLite cannot return the schema cookie", () => {
    const { options } = createExistingState();
    withExistingOpenClawStateSchema(options, () => {
      const database = openOpenClawStateDatabase(options);
      requireNativeSqliteDatabase(database.db).setAuthorizer((action, name) =>
        action === constants.SQLITE_PRAGMA && name === "schema_version"
          ? constants.SQLITE_IGNORE
          : constants.SQLITE_OK,
      );
      try {
        expect(() => openOpenClawStateDatabase(options)).toThrow(/schema version is unavailable/i);
      } finally {
        requireNativeSqliteDatabase(database.db).setAuthorizer(null);
      }
    });
  });

  it("checks the supplied database path rather than trusting an options path", () => {
    const selected = createExistingState();
    const other = createExistingState();
    const otherDatabase = openOpenClawStateDatabase(other.options);
    withExistingOpenClawStateSchema(selected.options, () => {
      expect(() => openOpenClawStateDatabase(other.options)).toThrow(/bound to/i);
      expect(() =>
        openOpenClawStateDatabase({ ...selected.options, database: otherDatabase }),
      ).toThrow(/bound to/i);
      const forgedOptions = {
        ...selected.options,
        database: { ...otherDatabase, path: selected.options.path },
      };
      for (const run of [
        () => openOpenClawStateDatabase(forgedOptions),
        () => runOpenClawStateWriteTransaction(() => "must not run", forgedOptions),
        () => runWithOpenClawStateBusyTimeout(() => "must not run", forgedOptions, 0),
      ]) {
        expect(run).toThrow(/bound to|selected physical database/i);
      }
      expect(readSchemaState(openOpenClawStateDatabase(selected.options).db)).toEqual(
        selected.before,
      );
    });
  });

  it("retains async admission until completion and revokes detached descendants afterward", async () => {
    const { options, before } = createExistingState();
    const releaseDescendant = createDeferred();
    const { lateWrite, database } = await withExistingOpenClawStateSchema(options, async () => {
      const admittedDatabase = openOpenClawStateDatabase(options);
      await Promise.resolve();
      expect(getExistingOpenClawStateSchemaPath()).toBe(options.path);
      writeConfigMachineState("node.admitted", true, options);
      return {
        database: admittedDatabase,
        lateWrite: releaseDescendant.promise.then(() =>
          writeConfigMachineState("node.expired", true, { ...options, database: admittedDatabase }),
        ),
      };
    });
    expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
    const rejection = expect(lateWrite).rejects.toThrow(/admission has ended/i);
    releaseDescendant.resolve();
    await rejection;
    expect(
      database.db
        .prepare("SELECT state_key FROM config_machine_state WHERE state_key LIKE 'node.%'")
        .all(),
    ).toEqual([{ state_key: "node.admitted" }]);
    expect(readSchemaState(database.db)).toEqual(before);
  });
});
