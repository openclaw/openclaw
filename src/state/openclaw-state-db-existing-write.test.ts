import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as maintenance from "../infra/state-database-maintenance.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  openExistingOpenClawStateWriter,
  runExistingOpenClawStateWriteTransaction,
} from "./openclaw-state-db-existing-write.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { ensureUserPreferencesSchema } from "./user-preferences.store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const recordSchema = "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;";
const contract = { schemaSql: recordSchema, operationLabel: "retained writer test" };
const schemaInventorySql =
  /\b(?:sqlite_schema|sqlite_master|(?:pragma_)?(?:table|index)_(?:list|info|xinfo))\b/iu;

function fixture(fullSchema = false) {
  const root = tempDirs.make("openclaw-existing-writer-");
  const options = { path: path.join(root, "state.sqlite"), env: { OPENCLAW_STATE_DIR: root } };
  const database = new DatabaseSync(options.path);
  try {
    database.exec(
      fullSchema
        ? OPENCLAW_STATE_SCHEMA_SQL
        : `
      CREATE TABLE schema_meta (
        meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE config_machine_state (
        state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
      );
    `,
    );
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
      INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
        VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, 1, 1);
      ${recordSchema}
    `);
  } finally {
    database.close();
  }
  return options;
}

function readValues(pathname: string) {
  const database = new DatabaseSync(pathname, { readOnly: true });
  try {
    return database.prepare("SELECT value FROM records ORDER BY id").all();
  } finally {
    database.close();
  }
}

function readSchemaMarkers(database: DatabaseSync) {
  return {
    userVersion: database.prepare("PRAGMA user_version").get()?.user_version,
    schemaVersion: database.prepare("PRAGMA schema_version").get()?.schema_version,
  };
}

describe("retained existing-state writer", () => {
  it("refuses invalid and restricted repair admission before acquiring schema maintenance", () => {
    const options = fixture();
    const repairContract = { ...contract, recoverTaskDeliveryOrphans: true as const };
    const lease = vi.spyOn(maintenance, "withStateDatabaseSchemaMaintenance");
    const mutate = vi.fn();
    try {
      expect(() =>
        runExistingOpenClawStateWriteTransaction(
          mutate,
          { ...options, readOnly: true },
          repairContract,
        ),
      ).toThrow(/own tracked writable connection/iu);
      expect(() =>
        withExistingOpenClawStateSchema(options, () =>
          runExistingOpenClawStateWriteTransaction(mutate, options, repairContract),
        ),
      ).toThrow(/schema repair is owned/iu);
      expect(lease).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      lease.mockRestore();
    }
  });

  it("preserves a replacement appearing during schema lease acquisition", () => {
    const options = fixture();
    const replacement = fixture();
    const replacementDatabase = new DatabaseSync(replacement.path);
    try {
      replacementDatabase.exec("INSERT INTO records VALUES (99, 'replacement preserved')");
    } finally {
      replacementDatabase.close();
    }
    const replacementBytes = fs.readFileSync(replacement.path);
    const withMaintenance = maintenance.withStateDatabaseSchemaMaintenance;
    const lease = vi
      .spyOn(maintenance, "withStateDatabaseSchemaMaintenance")
      .mockImplementation((leaseOptions, operation) =>
        withMaintenance(leaseOptions, () => {
          fs.renameSync(options.path, `${options.path}.retired`);
          fs.copyFileSync(replacement.path, options.path);
          return operation();
        }),
      );
    const mutate = vi.fn(({ db }: { db: DatabaseSync }) => {
      db.exec("INSERT INTO records VALUES (1, 'wrong generation')");
    });
    try {
      expect(() =>
        runExistingOpenClawStateWriteTransaction(mutate, options, {
          ...contract,
          recoverTaskDeliveryOrphans: true,
        }),
      ).toThrow(/generation/iu);
      expect(lease).toHaveBeenCalledOnce();
      expect(mutate).not.toHaveBeenCalled();
      expect(fs.readFileSync(options.path).equals(replacementBytes)).toBe(true);
      expect(readValues(options.path)).toEqual([{ value: "replacement preserved" }]);
    } finally {
      lease.mockRestore();
    }
  });

  it("retains WAL files and one integrity admission through ordinary local and sibling writes", () => {
    const options = fixture();
    const reads = observeSqliteReadSql(StatementSync.prototype);
    const writer = openExistingOpenClawStateWriter(options, contract);
    let retained: DatabaseSync | undefined;
    try {
      writer.run(({ db }) => {
        retained = db;
        db.prepare("INSERT INTO records VALUES (?, ?)").run(1, "first");
      }, options);
      const sidecars = ["-wal", "-shm"].map((suffix) => {
        const stat = fs.statSync(`${options.path}${suffix}`);
        return { dev: stat.dev, ino: stat.ino };
      });
      const external = openNodeSqliteDatabase(options.path);
      try {
        external.prepare("INSERT INTO records VALUES (?, ?)").run(2, "foreign");
      } finally {
        external.close();
      }
      writer.run(({ db }) => {
        expect(db).toBe(retained);
        db.prepare("INSERT INTO records VALUES (?, ?)").run(3, "last");
      }, options);
      const warmQueryCount = reads.queries.length;
      writer.run(({ db }) => {
        db.prepare("INSERT INTO records VALUES (?, ?)").run(4, "warm");
      }, options);
      expect(
        reads.queries.slice(warmQueryCount).filter((sql) => schemaInventorySql.test(sql)),
      ).toEqual([]);
      writer.assertSettled();
      expect(readValues(options.path)).toEqual([
        { value: "first" },
        { value: "foreign" },
        { value: "last" },
        { value: "warm" },
      ]);
      expect(
        ["-wal", "-shm"].map((suffix) => {
          const stat = fs.statSync(`${options.path}${suffix}`);
          return { dev: stat.dev, ino: stat.ino };
        }),
      ).toEqual(sidecars);
      expect(
        reads.queries.filter((sql) => /^PRAGMA integrity_check\s*;?$/iu.test(sql)),
      ).toHaveLength(1);
      expect(
        reads.queries.filter((sql) => /^PRAGMA foreign_key_check\s*;?$/iu.test(sql)),
      ).toHaveLength(1);
    } finally {
      writer.close();
      reads.restore();
    }
    expect(retained?.isOpen).toBe(false);
    expect(fs.existsSync(`${options.path}-wal`)).toBe(false);
    expect(fs.existsSync(`${options.path}-shm`)).toBe(false);
  });

  it("readmits canonical same-version lazy DDL once before resuming warm subset writes", async () => {
    const options = fixture(true);
    const peer = openOpenClawStateDatabase(options);
    peer.db.exec("DROP TABLE user_preferences");
    const version = peer.db.prepare("PRAGMA user_version").get();
    const writer = openExistingOpenClawStateWriter(options, contract);
    const reads = observeSqliteReadSql(StatementSync.prototype);
    try {
      writer.run(({ db }) => {
        expect(db).not.toBe(peer.db);
        db.exec("INSERT INTO records VALUES (1, 'before addition')");
      }, options);
      ensureUserPreferencesSchema({ ...options, database: peer });
      expect(peer.db.prepare("SELECT COUNT(*) AS total FROM user_preferences").get()).toEqual({
        total: 0,
      });
      expect(peer.db.prepare("PRAGMA user_version").get()).toEqual(version);
      writer.run(({ db }) => {
        db.exec("INSERT INTO records VALUES (2, 'after addition')");
      }, options);
      const readmittedQueryCount = reads.queries.length;
      writer.run(({ db }) => {
        db.exec("INSERT INTO records VALUES (3, 'warm again')");
      }, options);
      expect(
        reads.queries
          .slice(readmittedQueryCount)
          .filter(
            (sql) =>
              schemaInventorySql.test(sql) ||
              /\b(?:integrity_check|quick_check|foreign_key_check)\b/iu.test(sql),
          ),
      ).toEqual([]);
      expect(readValues(options.path)).toEqual([
        { value: "before addition" },
        { value: "after addition" },
        { value: "warm again" },
      ]);
    } finally {
      reads.restore();
      writer.close();
      await closeOpenClawStateDatabaseByPathAsync(options.path);
    }
  });

  it("retains a failed close for cleanup while refusing further writes", () => {
    const options = fixture();
    const writer = openExistingOpenClawStateWriter(options, contract);
    const retained = writer.run(({ db }) => {
      db.exec("INSERT INTO records VALUES (1, 'preserved')");
      return db;
    }, options);
    const failure = new Error("synthetic native close failure");
    const nativeClose = vi.spyOn(retained, "close").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => writer.close()).toThrow(failure);
      expect(retained?.isOpen).toBe(true);
      expect(fs.existsSync(`${options.path}-wal`)).toBe(true);
      const mutate = vi.fn();
      expect(() => writer.run(mutate, options)).toThrow(/closed/iu);
      expect(mutate).not.toHaveBeenCalled();
      writer.close();
      expect(retained?.isOpen).toBe(false);
      expect(fs.existsSync(`${options.path}-wal`)).toBe(false);
      expect(fs.existsSync(`${options.path}-shm`)).toBe(false);
      expect(readValues(options.path)).toEqual([{ value: "preserved" }]);
    } finally {
      nativeClose.mockRestore();
      writer.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects replacement before a retained write callback",
    () => {
      const options = fixture();
      const writer = openExistingOpenClawStateWriter(options, contract);
      try {
        writer.run(() => undefined, options);
        const replacement = fixture();
        fs.renameSync(options.path, `${options.path}.retired`);
        fs.copyFileSync(replacement.path, options.path);
        const mutate = vi.fn();
        expect(() => writer.run(mutate, options)).toThrow(/generation/iu);
        expect(mutate).not.toHaveBeenCalled();
        expect(readValues(options.path)).toEqual([]);
      } finally {
        writer.close();
      }
    },
  );

  it.each([
    {
      change: "foreign schema",
      sql: "ALTER TABLE records ADD COLUMN foreign_value TEXT",
      error: /column definitions differ for records/iu,
      markersChange: true,
    },
    {
      change: "foreign version",
      sql: `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
      error: /newer schema version/iu,
      markersChange: true,
    },
    {
      change: "deferred content marker removed",
      sql: "DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
      error: /requires schema migration by its owning installation/iu,
      deferred: true,
    },
    {
      change: "role changed",
      sql: "UPDATE schema_meta SET role = 'agent' WHERE meta_key = 'primary'",
      error: /schema role agent/iu,
    },
    {
      change: "metadata version changed",
      sql: `UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1} WHERE meta_key = 'primary'`,
      error: /schema metadata is inconsistent/iu,
    },
    {
      change: "primary row deleted",
      sql: "DELETE FROM schema_meta WHERE meta_key = 'primary'",
      error: /schema role missing/iu,
    },
    {
      change: "content version newer than supported",
      sql: `INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${OPENCLAW_STATE_SCHEMA_VERSION + 1}', 1)`,
      error: /newer schema version/iu,
    },
    {
      change: "content version malformed",
      sql: "INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '{', 1)",
      error: /invalid shared state schema content version/iu,
    },
  ])("rejects $change at first admission", ({ sql, error, markersChange, deferred }) => {
    const options = fixture(deferred);
    if (deferred) {
      const setup = new DatabaseSync(options.path);
      try {
        setup.exec(`
          PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
          UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}
            WHERE meta_key = 'primary';
          INSERT INTO config_machine_state VALUES
            ('state.schema.contentVersion', '${OPENCLAW_STATE_SCHEMA_VERSION}', 1);
        `);
      } finally {
        setup.close();
      }
    }
    const run = () => {
      // Raw fixture connections leave this physical file unadmitted until the writer opens it.
      const external = new DatabaseSync(options.path);
      try {
        const before = readSchemaMarkers(external);
        external.exec(sql);
        if (!markersChange) {
          expect(readSchemaMarkers(external)).toEqual(before);
        }
      } finally {
        external.close();
      }
      const writer = openExistingOpenClawStateWriter(options, contract);
      try {
        const mutate = vi.fn(({ db }: { db: DatabaseSync }) => {
          db.exec("INSERT INTO records VALUES (2, 'refused')");
        });
        expect(() => writer.run(mutate, options)).toThrow(error);
        expect(mutate).not.toHaveBeenCalled();
        expect(readValues(options.path)).toEqual([]);
      } finally {
        writer.close();
      }
    };
    if (deferred) {
      withExistingOpenClawStateSchema(options, run);
    } else {
      run();
    }
  });

  it.each([
    { kind: "literal", sql: "SELECT 'CREATE' AS action", action: "CREATE" },
    {
      kind: "escaped literal",
      sql: "SELECT 'DROP ''table''; PRAGMA user_version = 4' AS action",
      action: "DROP 'table'; PRAGMA user_version = 4",
    },
    {
      kind: "quoted identifier",
      sql: `SELECT "CREATE" AS action FROM (SELECT 'kept' AS "CREATE")`,
      action: "kept",
    },
    {
      kind: "comments",
      sql: "/* CREATE TABLE ignored(id); */ SELECT 'kept' AS action -- ALTER TABLE ignored ADD extra",
      action: "kept",
    },
  ])("commits $kind SQL payloads without revalidating format", ({ sql, action }) => {
    const options = fixture();
    const writer = openExistingOpenClawStateWriter(options, contract);
    let observation: ReturnType<typeof observeSqliteReadSql> | undefined;
    try {
      expect(
        writer.run(({ db }) => {
          observation = observeSqliteReadSql(StatementSync.prototype);
          const row = db.prepare(sql).get();
          if (typeof row?.action !== "string") {
            throw new Error("Expected the SQL payload to return action text");
          }
          db.prepare("INSERT INTO records VALUES (1, ?)").run(row.action);
          return row;
        }, options),
      ).toEqual({ action });
      if (!observation) {
        throw new Error("Existing-state write callback did not execute");
      }
      expect(
        observation.queries.filter(
          (query) =>
            schemaInventorySql.test(query) ||
            /^PRAGMA\s+(?:user_version|schema_version)\b/iu.test(query),
        ),
      ).toEqual([]);
      expect(readValues(options.path)).toEqual([{ value: action }]);
    } finally {
      observation?.restore();
      writer.close();
    }
  });

  it.each([
    "CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT",
    `PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION}`,
    "REINDEX",
  ])("commits no-op schema statements without claiming a migration: %s", (sql) => {
    const options = fixture();
    const writer = openExistingOpenClawStateWriter(options, contract);
    try {
      writer.run(({ db }) => {
        db.exec(sql);
        db.exec("INSERT INTO records VALUES (1, 'committed')");
      }, options);
      expect(readValues(options.path)).toEqual([{ value: "committed" }]);
    } finally {
      writer.close();
    }
  });

  it("rechecks current environment for each retained write", () => {
    const options = fixture(true);
    const externalOptions = {
      ...options,
      env: { ...options.env, OPENCLAW_SUPERVISOR_MODE: "external" },
    };
    const setup = new DatabaseSync(options.path);
    try {
      setup.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
        "gateway.supervision",
        JSON.stringify({
          version: 1,
          mode: "external",
          managerId: "fixture-owner",
          claimedAt: 1,
        }),
        1,
      );
    } finally {
      setup.close();
    }
    const writer = withExistingOpenClawStateSchema(options, () => {
      const result = openExistingOpenClawStateWriter(externalOptions, contract);
      try {
        result.run(
          ({ db }) => db.exec("INSERT INTO records VALUES (1, 'authorized')"),
          externalOptions,
        );
        const refused = vi.fn();
        expect(() => result.run(refused, options)).toThrow(/external|managed/iu);
        expect(refused).not.toHaveBeenCalled();
        return result;
      } catch (error) {
        result.close();
        throw error;
      }
    });
    try {
      withExistingOpenClawStateSchema(options, () => {
        writer.run(
          ({ db }) => db.exec("INSERT INTO records VALUES (2, 'readmitted')"),
          externalOptions,
        );
      });
      expect(readValues(options.path)).toEqual([{ value: "authorized" }, { value: "readmitted" }]);
    } finally {
      writer.close();
    }
  });
});
