import assert from "node:assert/strict";
import { copyFileSync, existsSync, renameSync, symlinkSync } from "node:fs";
import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import {
  captureSqliteWorkerStateContext,
  runWithSqliteWorkerStateContext,
} from "../infra/sqlite-worker-state-context.js";
import { NodeWorkerPreparedWorkspaceStore } from "../node-host/node-worker-prepared-workspace-store.js";
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

function readSchemaState(db: DatabaseSync) {
  return {
    version: db.prepare("PRAGMA user_version").get(),
    metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    content: db
      .prepare("SELECT * FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'")
      .get(),
  };
}

function readPersistedSchema(pathname: string) {
  const db = new DatabaseSync(pathname, { readOnly: true });
  try {
    return {
      ...readSchemaState(db),
      schema: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(),
    };
  } finally {
    db.close();
  }
}

function createExistingState(mutate?: (db: DatabaseSync) => void) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-existing-schema-") };
  const pathname = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabase();
  const seedPath = `${pathname}.seed`;
  renameSync(pathname, seedPath);
  copyFileSync(seedPath, pathname);
  const db = new DatabaseSync(pathname);
  try {
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
    return { options: { env, path: pathname }, before: readSchemaState(db) };
  } finally {
    db.close();
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

describe("ordinary shared-state reader admission", () => {
  it("reuses cold schema facts without adding a warm freshness probe", () => {
    const { options } = createExistingState();
    const read = () =>
      withOpenClawStateReadOnlyLocation(
        ({ db }) =>
          db.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
        options.path,
        options.path,
        undefined,
        undefined,
        undefined,
        true,
      );
    const reads = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(read()).toEqual({ app_version: previousAppVersion });
      const coldVersionReads = reads.queries.filter((sql) => /^PRAGMA user_version\b/iu.test(sql));
      const coldContentReads = reads.queries.filter((sql) =>
        /\bconfig_machine_state\b/iu.test(sql),
      );
      reads.queries.length = 0;
      expect(read()).toEqual({ app_version: previousAppVersion });
      expect({
        coldPublishedVersion: coldVersionReads.length,
        coldContentVersion: coldContentReads.length,
        warmPublishedVersion: reads.queries.filter((sql) => /^PRAGMA user_version\b/iu.test(sql))
          .length,
        warmContentVersion: reads.queries.filter((sql) => /\bconfig_machine_state\b/iu.test(sql))
          .length,
        warmFreshness: reads.queries.filter((sql) =>
          /(?:^PRAGMA data_version\b|\bFROM main\.pragma_data_version\(\))/iu.test(sql),
        ).length,
      }).toEqual({
        coldPublishedVersion: 1,
        coldContentVersion: 1,
        warmPublishedVersion: 0,
        warmContentVersion: 0,
        warmFreshness: 0,
      });
    } finally {
      reads.restore();
      closeRetainedOpenClawStateReadConnections();
    }
  });

  it("observes an owned migration committed during first reader admission", () => {
    const previousVersion = OPENCLAW_STATE_SCHEMA_VERSION - 1;
    const { options } = createExistingState((database) => {
      database.exec(`PRAGMA user_version = ${previousVersion};
        UPDATE schema_meta SET schema_version = ${previousVersion} WHERE meta_key = 'primary';`);
    });
    const peer = openTrackedStateDatabase(options.path);
    let upgraded = false;
    // oxlint-disable-next-line typescript/unbound-method -- The proxy retains the native statement receiver.
    const nativeGet = StatementSync.prototype.get;
    const observer = vi.spyOn(StatementSync.prototype, "get").mockImplementation(
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
    const read = vi.fn(({ db }: { db: DatabaseSync }) => ({
      version: readStateSchemaContentVersion(db),
      metadata: db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    }));
    try {
      expect(withOpenClawStateReadOnlyLocation(read, options.path, options.path)).toEqual({
        version: OPENCLAW_STATE_SCHEMA_VERSION,
        metadata: { schema_version: OPENCLAW_STATE_SCHEMA_VERSION },
      });
      expect(upgraded).toBe(true);
      expect(read).toHaveBeenCalledOnce();
    } finally {
      observer.mockRestore();
      peer.close();
    }
  });

  it("publishes migration-owned content versions across rollback and sibling settlement", () => {
    const previousVersion = OPENCLAW_STATE_SCHEMA_VERSION - 1;
    const { options } = createExistingState((database) => {
      database.exec(`PRAGMA user_version = ${previousVersion};
        UPDATE schema_meta SET schema_version = ${previousVersion} WHERE meta_key = 'primary';`);
    });
    const db = openTrackedStateDatabase(options.path);
    const peer = openTrackedStateDatabase(options.path);
    const read = () => runSqliteReadOperationSync(db, () => readStateSchemaContentVersion(db));
    try {
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
    } finally {
      peer.close();
      db.close();
    }
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function").each([false, true])(
    "rechecks content-marker authorization after a successful read (admitted=%s)",
    (admitted) => {
      const { options } = createExistingState();
      const db = openTrackedStateDatabase(options.path);
      const read = () => runSqliteReadOperationSync(db, () => readStateSchemaContentVersion(db));
      try {
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
      } finally {
        db.setAuthorizer(null);
        db.close();
      }
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
      const reads = observeSqliteReadSql(StatementSync.prototype);
      try {
        const database = await open();
        assert(database);
        try {
          expect(
            reads.queries.filter((sql) => /^PRAGMA integrity_check\b/iu.test(sql)),
          ).toHaveLength(1);
          expect(
            reads.queries.filter((sql) => /^PRAGMA foreign_key_check\b/iu.test(sql)),
          ).toHaveLength(1);
          expect(readSchemaState(database.db)).toEqual(before);
        } finally {
          database.walMaintenance.close();
        }
      } finally {
        reads.restore();
      }

      const corrupted = new DatabaseSync(options.path);
      try {
        insertForeignKeyCorruption(corrupted);
      } finally {
        corrupted.close();
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
        const reads = observeSqliteReadSql(StatementSync.prototype);
        const checkCount = () =>
          reads.queries.filter((sql) => /^PRAGMA integrity_check\b/iu.test(sql)).length;
        try {
          expect(read()).toEqual(before);
          expect(read()).toEqual(before);
          expect(checkCount()).toBe(1);
          expect(
            reads.queries.filter((sql) => /^PRAGMA foreign_key_check\b/iu.test(sql)),
          ).toHaveLength(1);
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
            await closeOpenClawStateDatabaseAsync();
            expect(read(capture())).toEqual(before);
          }
          expect(checkCount()).toBe(change === "replacement" ? 2 : 1);
        } finally {
          reads.restore();
        }
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
        const database = openTrackedStateDatabase(options.path);
        const reads = observeSqliteReadSql(StatementSync.prototype);
        const admit = () =>
          assertExistingOpenClawStateRuntimeSchema(database, options.path, context.stateIntegrity);
        try {
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
          expect(
            reads.queries.filter((sql) => /^PRAGMA integrity_check\b/iu.test(sql)),
          ).toHaveLength(settlement === "managed commit" ? 1 : 2);
        } finally {
          reads.restore();
          database.close();
        }
      });
    },
  );

  it.each(["reader", "writer", "closed reader", "module graph"] as const)(
    "revokes transported integrity proof after %s corruption",
    async (kind) => {
      const { options, before } = createExistingState();
      const host = createOpenClawStateDatabaseAsyncLifecycle();
      await withExistingOpenClawStateSchema(options, async () => {
        const context = captureSqliteWorkerStateContext(
          captureOpenClawStateReadWorkerContextWithAdmission(options, host.capture),
        );
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
        const reads = observeSqliteReadSql(StatementSync.prototype);
        try {
          expect(read()).toEqual(before);
          expect(read()).toEqual(before);
          expect(
            reads.queries.filter((sql) => /^PRAGMA integrity_check\b/iu.test(sql)),
          ).toHaveLength(1);
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
          const db = new DatabaseSync(options.path);
          try {
            insertForeignKeyCorruption(db);
          } finally {
            db.close();
          }
          expect(read).toThrow(/foreign_key_check/i);
        } finally {
          reads.restore();
        }
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
    const preserved = new DatabaseSync(options.path, { readOnly: true });
    try {
      expect(preserved.prepare("SELECT * FROM agent_databases").all()).toEqual([
        {
          agent_id: "main",
          path: "legacy.sqlite",
          schema_version: 1,
          last_seen_at: 10,
          size_bytes: 20,
        },
      ]);
    } finally {
      preserved.close();
    }
  });

  it.each(["transaction", "implicit pin"] as const)(
    "observes an owned migration after its %s read snapshot ends",
    (snapshot) => {
      const previousVersion = OPENCLAW_STATE_SCHEMA_VERSION - 1;
      const { options } = createExistingState((database) => {
        database.exec(`PRAGMA user_version = ${previousVersion};
          UPDATE schema_meta SET schema_version = ${previousVersion} WHERE meta_key = 'primary';`);
      });
      const db = openTrackedStateDatabase(options.path);
      const peer = openTrackedStateDatabase(options.path);
      admitSqliteSchema(db);
      const read = () => runSqliteReadOperationSync(db, () => readStateSchemaContentVersion(db));
      expect(read()).toBe(previousVersion);
      const reads = observeSqliteReadSql(StatementSync.prototype);
      const readSnapshot = () => {
        expect(
          db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
        ).toEqual({ schema_version: previousVersion });
        expect(read()).toBe(previousVersion);
        runManagedStateTransaction(peer, () => markCurrentStateSchemaVersion(peer), {
          operationLabel: "state.version.snapshot.fixture",
        });
        expect(read()).toBe(previousVersion);
        expect(
          db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
        ).toEqual({ schema_version: previousVersion });
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
        expect(
          db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
        ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
        expect(reads.queries.filter((sql) => /data_version/iu.test(sql))).toEqual([]);
      } finally {
        reads.restore();
        if (db.isTransaction) {
          db.exec("ROLLBACK");
        }
        peer.close();
        db.close();
      }
    },
  );

  it("writes node state and initializes its lazy store without taking over release repair", async () => {
    const { options, before } = createExistingState((db) => {
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
    expect(
      reopened.db.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual({ app_version: previousAppVersion });
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
    expect(
      repaired.db.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual({ app_version: previousAppVersion });
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
      name: "newer unpublished content",
      sql: `INSERT INTO config_machine_state VALUES
              ('state.schema.contentVersion', '${OPENCLAW_STATE_SCHEMA_VERSION + 1}', 1);`,
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
    ({ sql, expectedError = /schema|foreign_key_check/i }) => {
      const { options } = createExistingState((db) => db.exec(sql));
      const before = readPersistedSchema(options.path);
      expect(() =>
        withExistingOpenClawStateSchema(options, () => openOpenClawStateDatabase(options)),
      ).toThrow(expectedError);
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
      expect(
        reopened.db.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ app_version: previousAppVersion });
    },
  );

  it("inspects schema indexes once and observes managed same-version changes before handle reuse", () => {
    const { options } = createExistingState();
    const reads = observeSqliteReadSql(StatementSync.prototype);
    try {
      withExistingOpenClawStateSchema(options, () => {
        const database = openOpenClawStateDatabase(options);
        expect(
          reads.queries.filter(
            (sql) => sql.includes("index_xinfo") && sql.includes("idx_plugin_state_listing"),
          ).length,
        ).toBeLessThanOrEqual(1);
        const external = openTrackedStateDatabase(options.path);
        try {
          external.exec("ALTER TABLE worker_environments DROP COLUMN preparation_purpose");
        } finally {
          external.close();
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
    } finally {
      reads.restore();
    }
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
      const database = new DatabaseSync(options.path, { defensive: false });
      try {
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
      } finally {
        database.close();
      }
    },
  );

  it("refuses admission when SQLite cannot return the schema cookie", () => {
    const { options } = createExistingState();
    withExistingOpenClawStateSchema(options, () => {
      const database = openOpenClawStateDatabase(options);
      database.db.setAuthorizer((action, name) =>
        action === constants.SQLITE_PRAGMA && name === "schema_version"
          ? constants.SQLITE_IGNORE
          : constants.SQLITE_OK,
      );
      try {
        expect(() => openOpenClawStateDatabase(options)).toThrow(/schema version is unavailable/i);
      } finally {
        database.db.setAuthorizer(null);
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
