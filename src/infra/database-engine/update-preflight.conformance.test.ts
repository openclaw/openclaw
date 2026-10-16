import "../../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { acquireGatewayLock } from "../gateway-lock.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { runLegacyStateMigrationSteps } from "../state-migrations.steps.js";
import { UpdateCandidatePluginPlanSchema } from "../update-candidate-plugins.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "../update-candidate-state.inspection.js";
import {
  UpdateCandidateSnapshotInventorySchema,
  UpdateCandidateStateSnapshotSchema,
  UpdateStateSchemaInspectionPlanSchema,
} from "../update-candidate-state.js";
import {
  createUpdateDatabaseBackup,
  type UpdateDatabaseBackup,
} from "../update-database-backup.js";
import { assertUpdateDatabaseEngineContexts } from "../update-database-engine-admission.js";
import { restoreUpdateDatabaseBackup } from "../update-database-restore.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { materializeDatabasePort } from "./port.worker.js";
import { statePortProvider } from "./state-port.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);
const runId = "postgres-update-conformance";

describe.skipIf(!connection)("PostgreSQL updater preflight and exact recovery", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  let root: string;
  let stateDir: string;
  let shared: string;
  let agent: string;
  let plugin: string;
  let namespace: string;
  let config: OpenClawConfig;
  let env: NodeJS.ProcessEnv;
  let anchorCreated = false;

  beforeAll(async () => {
    await client.connect();
    root = await fs.realpath(directories.make("update-postgres-"));
    stateDir = path.join(root, "state");
    shared = path.join(stateDir, "state", "openclaw.sqlite");
    agent = path.join(root, "registered-agent", "openclaw-agent.sqlite");
    plugin = path.join(stateDir, "npm", "projects", "fixture", "node_modules", "fixture-plugin");
    const configPath = path.join(stateDir, "openclaw.json");
    env = {
      ...process.env,
      HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    config = { database: { engine: "postgres", postgres: { connection: connection! } } };
    for (const directory of [path.dirname(shared), path.dirname(agent), plugin]) {
      await fs.mkdir(directory, { recursive: true });
    }
    await fs.writeFile(configPath, JSON.stringify(config));
    await fs.writeFile(
      path.join(plugin, "package.json"),
      '{"name":"fixture-plugin","version":"1.0.0"}',
    );
    await fs.writeFile(path.join(plugin, "index.js"), "export default {};\n");
    {
      using db = openNodeSqliteDatabase(agent);
      db.exec(
        "PRAGMA user_version = 7; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('agent baseline')",
      );
    }
    const descriptor = await statePortProvider.loadDescriptor();
    const storeId = randomUUID();
    namespace = `update_conformance_${storeId.replaceAll("-", "")}`;
    namespaces.add(namespace);
    {
      using source = openNodeSqliteDatabase(":memory:");
      source.exec(descriptor.sqlite);
      for (const fragment of descriptor.fragments ?? []) {
        source.exec(fragment.sqlite);
      }
      source.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
      source
        .prepare("INSERT INTO schema_meta VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)")
        .run(OPENCLAW_STATE_SCHEMA_VERSION);
      source
        .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
        .run("state.schema.contentVersion", String(OPENCLAW_STATE_SCHEMA_VERSION));
      source
        .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
        .run("update.conformance", ' {"value":"baseline","opaque":"\\u0061"} ');
      source.prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)").run(
        "plugins.installedIndex",
        JSON.stringify({
          revision: 1,
          index: {
            installRecords: {
              fixture: { source: "npm", spec: "fixture-plugin@1.0.0", installPath: plugin },
            },
          },
        }),
      );
      source
        .prepare(
          "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES ('registered', ?, 7, 1)",
        )
        .run(agent);
      source
        .prepare(
          "INSERT INTO update_runs (run_id, created_at_ms, updated_at_ms, trigger, phase, status, origin_json, target_json, before_json, after_json, steps_json, verification_json, repair_json) VALUES (?, 1, 1, 'cli', 'requested', 'running', '{}', '{}', '{}', '{}', '[]', '{}', '[]')",
        )
        .run(runId);
      await materializeDatabasePort({
        source: { engine: "sqlite", db: source },
        destination: { engine: "postgres", db: client, namespace },
        descriptor,
        storeId,
        assertCurrent() {},
      });
    }
    {
      using anchor = openNodeSqliteDatabase(shared);
      anchor.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
      );
      anchor
        .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
        .run(storeId, namespace);
      anchorCreated = true;
    }
    for (const key of [
      "HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    ]) {
      vi.stubEnv(key, env[key]);
    }
    resetDatabaseEngineSelectionForTest();
    installDatabaseEngineSelection({ input: { connection: connection!, schemaPrefix: "update" } });
  });

  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetDatabaseEngineSelectionForTest();
    vi.unstubAllEnvs();
    try {
      if (anchorCreated) {
        const restored = readBackupEngine(shared);
        if (restored.engine === "postgres") {
          namespaces.add(restored.namespace);
        }
      }
      for (const name of namespaces) {
        await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  });

  async function inspect(mode: string, extra: Record<string, unknown> = {}) {
    const stagingRoot = path.join(root, `inspection-${randomUUID()}`);
    await fs.mkdir(stagingRoot);
    return runUpdateStateInspectionWorker({
      nodeRunner: process.execPath,
      sourceEnv: env,
      stagingRoot,
      databases: [{ path: shared, sizeBytes: (await fs.stat(shared, { bigint: true })).size }],
      input: { stateDir, config, mode, stagingRoot, ...extra },
    });
  }

  it("reads registry, installed plugins and schema versions from PostgreSQL without changing the anchor", async () => {
    const before = await fs.readFile(shared);
    const targetStateDir = path.join(root, "inventory");
    const candidateRoot = path.join(root, "candidate");
    await fs.mkdir(candidateRoot);
    await fs.writeFile(path.join(candidateRoot, "package.json"), '{"name":"openclaw"}');
    const inventory = parseUpdateStateInspectionWorker(
      await inspect("inventory", { targetStateDir, candidateRoot }),
      UpdateCandidateSnapshotInventorySchema,
    );
    expect([...inventory.databases.values()].flatMap((entry) => entry.spellings)).toContain(agent);
    const plan = UpdateCandidatePluginPlanSchema.parse(
      JSON.parse(await fs.readFile(path.join(targetStateDir, inventory.pluginPlan), "utf8")),
    );
    expect(plan.recordPaths.fixture).toMatchObject({ installPath: expect.any(String) });
    expect(plan.bindings).toContainEqual(expect.objectContaining({ source: plugin }));
    const discovery = parseUpdateStateInspectionWorker(
      await inspect("discover"),
      UpdateStateSchemaInspectionPlanSchema,
    );
    expect(discovery.sharedVersion).toMatchObject({
      path: shared,
      userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      contentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    const versions = parseUpdateStateInspectionWorker(
      await inspect("versions", { inspectionPlan: discovery }),
      z.array(z.object({ path: z.string(), userVersion: z.number().nullable() }).passthrough()),
    );
    expect(versions).toContainEqual(expect.objectContaining({ path: agent, userVersion: 7 }));
    const snapshot = parseUpdateStateInspectionWorker(
      await inspect("snapshot", {
        targetStateDir,
        candidateRoot,
        pluginPlanPath: path.join(targetStateDir, inventory.pluginPlan),
        databaseInventory: [...inventory.databases.keys()],
      }),
      UpdateCandidateStateSnapshotSchema,
    );
    expect(snapshot.versions).toEqual(versions);
    const privateShared = path.join(targetStateDir, "state", "openclaw.sqlite");
    expect(readBackupEngine(privateShared)).toEqual({ engine: "sqlite" });
    {
      using copied = openNodeSqliteDatabase(privateShared, { readOnly: true });
      expect(
        copied
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("update.conformance"),
      ).toEqual({ value_json: ' {"value":"baseline","opaque":"\\u0061"} ' });
      const row = copied
        .prepare("SELECT path FROM agent_databases WHERE agent_id = ?")
        .get("registered");
      expect(row?.path).toEqual(expect.stringMatching(/^candidate-external\//));
      using copiedAgent = openNodeSqliteDatabase(path.resolve(targetStateDir, String(row?.path)), {
        readOnly: true,
      });
      expect(copiedAgent.prepare("SELECT value FROM evidence").get()).toEqual({
        value: "agent baseline",
      });
    }
    expect(
      (
        await client.query(
          `SELECT path FROM "${namespace}".agent_databases WHERE agent_id = 'registered'`,
        )
      ).rows,
    ).toEqual([{ path: agent }]);
    expect(await fs.readFile(shared)).toEqual(before);
  });

  it("refuses an unsupported state family before disturbing the previous Gateway", async () => {
    const previous = await acquireGatewayLock({
      env,
      role: "gateway",
      allowInTests: true,
      timeoutMs: 0,
    });
    expect(previous).not.toBeNull();
    const before = await fs.readFile(shared);
    try {
      await expect(
        assertUpdateDatabaseEngineContexts(
          [{ config, env }],
          ["sqlite", "postgres"],
          ["workboard", "logbook", "team-reports"],
        ),
      ).rejects.toThrow(/state.*(port|version|candidate)|(?:port|version|candidate).*state/i);
      previous!.assertCurrent();
      expect(await fs.readFile(shared)).toEqual(before);
      await expect(
        assertUpdateDatabaseEngineContexts(
          [{ config, env }],
          ["sqlite", "postgres"],
          ["state", "workboard", "logbook", "team-reports"],
        ),
      ).resolves.toBeUndefined();
    } finally {
      await previous!.release();
    }
  });

  it("captures before a failed candidate migration and restores exact PostgreSQL rows while preserving current update history", async () => {
    const owner = await acquireGatewayLock({
      env,
      role: "sqlite-maintenance",
      allowInTests: true,
      timeoutMs: 0,
    });
    expect(owner).not.toBeNull();
    let backup: UpdateDatabaseBackup | undefined;
    try {
      backup = await owner!.run(() =>
        createUpdateDatabaseBackup({
          backupRoot: path.join(root, "rollback"),
          stateDir,
          config,
          env,
          acquisition: { mode: "maintenance-owner" },
        }),
      );
      expect(backup.databases).toContainEqual(
        expect.objectContaining({ path: shared, engine: "postgres", namespace }),
      );
      const migration = await owner!.run(() =>
        runLegacyStateMigrationSteps([
          {
            id: "update-conformance-failure",
            phase: "shared",
            source: [],
            target: [],
            requiredness: "required",
            reversibility: "not-applicable",
            run: async () => {
              await client.query(
                `UPDATE "${namespace}".config_machine_state SET value_json = '"candidate"' WHERE state_key = 'update.conformance'`,
              );
              await client.query(
                `UPDATE "${namespace}".update_runs SET phase = 'validating', updated_at_ms = 2, reason = 'candidate migration failed', after_json = $1 WHERE run_id = $2`,
                [' {"opaque":"\\u0062"} ', runId],
              );
              throw new Error("candidate migration failed after committed data write");
            },
          },
        ]),
      );
      expect(migration.haltedBy?.refusal?.code).toBe("step-threw");
      expect(
        (
          await client.query(
            `SELECT value_json FROM "${namespace}".config_machine_state WHERE state_key = 'update.conformance'`,
          )
        ).rows,
      ).toEqual([{ value_json: '"candidate"' }]);
    } finally {
      await owner!.release();
    }
    const displaced = await restoreUpdateDatabaseBackup({
      backup: backup!,
      runId,
      env,
      assertCurrent() {},
    });
    expect(displaced).not.toBeNull();
    const restored = readBackupEngine(shared);
    expect(restored.engine).toBe("postgres");
    if (restored.engine !== "postgres") {
      throw new Error("Recovery replaced the PostgreSQL anchor with SQLite data");
    }
    namespaces.add(restored.namespace);
    expect(
      (
        await client.query(
          `SELECT value_json FROM "${restored.namespace}".config_machine_state WHERE state_key = 'update.conformance'`,
        )
      ).rows,
    ).toEqual([{ value_json: ' {"value":"baseline","opaque":"\\u0061"} ' }]);
    expect(
      (
        await client.query(
          `SELECT phase, reason, after_json FROM "${restored.namespace}".update_runs WHERE run_id = $1`,
          [runId],
        )
      ).rows,
    ).toEqual([
      {
        phase: "validating",
        reason: "candidate migration failed",
        after_json: ' {"opaque":"\\u0062"} ',
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT path FROM "${restored.namespace}".agent_databases WHERE agent_id = 'registered'`,
        )
      ).rows,
    ).toEqual([{ path: agent }]);
  });
});
