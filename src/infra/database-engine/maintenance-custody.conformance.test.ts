import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { formatGatewayLockFailure } from "../gateway-lock-diagnostics.js";
import { acquireGatewayLock } from "../gateway-lock.js";
import { inspectGatewayOwnerLease } from "../gateway-owner-lease.worker.js";
import { requireNodeSqlite } from "../node-sqlite.js";
import { prepareSqliteReadOnlyLocationSync } from "../sqlite-snapshot-source.js";
import { createConfigMachineStateStep } from "../state-migrations.config-machine-state-step.js";
import { withLegacyMigrationStateLock } from "../state-migrations.lock.js";
import { runLegacyStateMigrationSteps } from "../state-migrations.steps.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);

function maintenanceLock(env: NodeJS.ProcessEnv) {
  return acquireGatewayLock({
    env,
    allowInTests: true,
    role: "sqlite-maintenance",
    timeoutMs: 0,
  });
}

describe.skipIf(!connection)("PostgreSQL Doctor maintenance custody", () => {
  const client = new Client({ connectionString: connection });
  let env: NodeJS.ProcessEnv;
  let namespace: string;
  const alterLeases = (clause: string) =>
    client.query(`ALTER TABLE "${namespace}".state_leases ${clause}`);
  async function expectRefusal(target: NodeJS.ProcessEnv, message: string) {
    const refusal: unknown = await maintenanceLock(target).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect(formatGatewayLockFailure(refusal)).toContain(message);
  }

  beforeAll(async () => {
    await client.connect();
    env = { ...process.env, OPENCLAW_STATE_DIR: directories.make("maintenance-postgres-") };
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: "maintenance_conformance" },
    });
    namespace = withEngineStoreAdmission(() =>
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          const facts = getPostgresPhysicalFacts(db);
          if (!facts) {
            throw new Error("Maintenance fixture did not select PostgreSQL");
          }
          return facts.namespace;
        },
        { env },
      ),
    );
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    resetDatabaseEngineSelectionForTest();
    try {
      if (namespace) {
        await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  });

  it("runs the config-machine-state step and a committed data step under reusable custody", async () => {
    const stateDir = env.OPENCLAW_STATE_DIR!;
    const statements: string[] = [];
    const observation = channel("openclaw.database.statement");
    const observe = (event: unknown) => {
      if (isRecord(event) && event.engine === "postgres" && typeof event.sql === "string") {
        statements.push(event.sql);
      }
    };
    observation.subscribe(observe);
    try {
      const result = await withLegacyMigrationStateLock({
        env,
        stateDir,
        label: "PostgreSQL conformance state",
        releaseLabel: "PostgreSQL conformance state",
        run: async (lockedEnv) => {
          const migration = await runLegacyStateMigrationSteps([
            createConfigMachineStateStep({
              config: {},
              configPath: path.join(stateDir, "openclaw.json"),
              configIncludedPaths: [],
              stateDir,
              env: lockedEnv,
            }),
            {
              id: "maintenance-conformance-data",
              phase: "shared",
              source: [],
              target: [],
              requiredness: "required",
              reversibility: "not-applicable",
              run: async () => {
                withEngineStoreAdmission(() =>
                  writeConfigMachineState("maintenance.conformance", "committed", {
                    env: lockedEnv,
                  }),
                );
                return { changes: ["Committed synthetic data migration"], warnings: [] };
              },
            },
          ]);
          expect(migration.haltedBy).toBeUndefined();
          expect(migration.receipts.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
            { id: "config-machine-state", outcome: "skipped" },
            { id: "maintenance-conformance-data", outcome: "completed" },
          ]);
          return {
            changes: migration.sources.flatMap((source) => source.changes),
            warnings: migration.sources.flatMap((source) => source.warnings),
          };
        },
      });
      expect(result).toEqual({
        changes: ["Committed synthetic data migration"],
        warnings: [],
      });
      expect(statements.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
      expect(statements.some((sql) => sql.includes("NOT INDEXED"))).toBe(false);
      const persisted = await client.query(
        `SELECT value_json FROM "${namespace}".config_machine_state WHERE state_key = $1`,
        ["maintenance.conformance"],
      );
      expect(persisted.rows).toEqual([{ value_json: '"committed"' }]);
      const reacquired = await maintenanceLock(env);
      expect(reacquired).not.toBeNull();
      await reacquired!.release();
      expect(() => reacquired!.assertCurrent()).toThrow();
    } finally {
      observation.unsubscribe(observe);
    }
  });

  it("refuses a live Gateway owner from a second anchor, including a newer PostgreSQL schema", async () => {
    closeOpenClawStateDatabaseForTest();
    const otherEnv = {
      ...env,
      OPENCLAW_STATE_DIR: directories.make("maintenance-postgres-second-anchor-"),
    };
    const otherPath = resolveOpenClawStateSqlitePath(otherEnv);
    fs.mkdirSync(path.dirname(otherPath), { recursive: true });
    fs.copyFileSync(resolveOpenClawStateSqlitePath(env), otherPath);
    const gateway = await acquireGatewayLock({
      env,
      allowInTests: true,
      role: "gateway",
      listenerMode: "foreground",
      port: 19483,
      timeoutMs: 0,
    });
    expect(gateway).not.toBeNull();
    let advanced = false;
    try {
      for (const newerSchema of [false, true]) {
        if (newerSchema) {
          await client.query(
            `UPDATE "${namespace}".openclaw_schema_meta SET version = version + 1 WHERE store = 'state'`,
          );
          advanced = true;
          await alterLeases("ADD COLUMN future_payload text");
        }
        await expectRefusal(otherEnv, "Gateway owner lease is still active");
      }
    } finally {
      if (advanced) {
        await alterLeases("DROP COLUMN IF EXISTS future_payload");
        await client.query(
          `UPDATE "${namespace}".openclaw_schema_meta SET version = version - 1 WHERE store = 'state'`,
        );
      }
      await gateway!.release();
    }
  });

  it("refuses maintenance when the stable PostgreSQL lease contract is missing", async () => {
    closeOpenClawStateDatabaseForTest();
    await alterLeases("RENAME COLUMN payload_json TO future_payload");
    try {
      await expectRefusal(env, "PostgreSQL Gateway owner lease table is missing or incompatible");
    } finally {
      await alterLeases("RENAME COLUMN future_payload TO payload_json");
    }
    const owner = await maintenanceLock(env);
    expect(owner).not.toBeNull();
    await owner!.release();
  });
});

it("preserves the SQLite maintenance inspection statements byte for byte", () => {
  resetDatabaseEngineSelectionForTest();
  installDatabaseEngineSelection({ effectiveEngines: resolveDatabaseFamilyEngines({}) });
  const env = { ...process.env, OPENCLAW_STATE_DIR: directories.make("maintenance-sqlite-") };
  runOpenClawStateWriteTransaction(() => {}, { env });
  const pathname = resolveOpenClawStateSqlitePath(env);
  const snapshot = prepareSqliteReadOnlyLocationSync(pathname);
  const prototype = requireNodeSqlite().DatabaseSync.prototype;
  const prepare = vi.spyOn(prototype, "prepare");
  const exec = vi.spyOn(prototype, "exec");
  try {
    expect(
      inspectGatewayOwnerLease(
        {
          databasePath: pathname,
          location: snapshot.location,
          snapshotRoot: snapshot.cleanupRoot,
        },
        () => {},
        true,
      ),
    ).toBeUndefined();
    const captured = [prepare, exec]
      .flatMap((spy) =>
        spy.mock.calls.map(([sql], index) => ({
          sql,
          order: spy.mock.invocationCallOrder[index],
        })),
      )
      .toSorted((a, b) => a.order! - b.order!)
      .map(({ sql }) => sql);
    expect(captured).toEqual([
      "BEGIN",
      "PRAGMA journal_mode",
      "PRAGMA user_version",
      "PRAGMA writable_schema = ON;",
      "SELECT tbl_name, rootpage, sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
      "PRAGMA writable_schema = RESET;",
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
      "SELECT owner, created_at AS createdAt,\n            expires_at AS expiresAt, heartbeat_at AS heartbeatAt, payload_json AS payloadJson\n            FROM state_leases NOT INDEXED\n            WHERE scope = ? AND lease_key = ?\n            LIMIT 2",
      "ROLLBACK",
    ]);
  } finally {
    prepare.mockRestore();
    exec.mockRestore();
    closeOpenClawStateDatabaseForTest();
    snapshot.cleanup();
    resetDatabaseEngineSelectionForTest();
  }
});
