import assert from "node:assert/strict";
import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NodeWorkerPreparedWorkspaceStore } from "../node-host/node-worker-prepared-workspace-store.js";
import { writeConfigMachineState } from "./config-machine-state-write.js";
import { readConfigMachineState } from "./config-machine-state.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import {
  getExistingOpenClawStateSchemaPath,
  withExistingOpenClawStateSchema,
} from "./openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  initializeNativeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseReadabilityForDoctor,
  repairOpenClawStateDatabaseSchema,
  prepareOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
  runWithOpenClawStateBusyTimeout,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "./openclaw-state-db.js";

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
  }
}

describe("existing shared-state schema admission", () => {
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
  ])("refuses $name without migrating or repairing the file", ({ sql }) => {
    const { options } = createExistingState((db) => db.exec(sql));
    const before = readPersistedSchema(options.path);
    expect(() =>
      withExistingOpenClawStateSchema(options, () => openOpenClawStateDatabase(options)),
    ).toThrow(/schema|foreign_key_check/i);
    expect(readPersistedSchema(options.path)).toEqual(before);
  });

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

  it("inspects schema indexes once and revalidates same-version changes before handle reuse", () => {
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
        const external = new DatabaseSync(options.path);
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
