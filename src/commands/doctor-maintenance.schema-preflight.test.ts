import "../flows/doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runDoctorHealthFlow } from "../flows/doctor-health.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { repairOpenClawStateDatabaseSchema } from "../state/openclaw-state-db-doctor.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as doctorConfigFlow from "./doctor-config-flow.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const { mocks } = await import("../flows/doctor-health.test-support.js");
beforeEach(() => {
  mocks.config.mockReturnValue({});
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.outro.mockClear();
  mocks.runContributions.mockReset();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function createLegacyRegistryFixture() {
  const root = tempDirs.make("openclaw-doctor-legacy-registry-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  })) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("OPENCLAW_HOME", undefined);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA user_version = 8;
    CREATE TABLE agent_databases (
      agent_id TEXT NOT NULL, path TEXT NOT NULL, schema_version INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, size_bytes INTEGER,
      PRIMARY KEY (agent_id, path)
    );
  `);
  database.close();
  const config: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {} } },
  };
  const begin = () =>
    beginDoctorMaintenance({
      options: { repair: true, nonInteractive: true },
      root: null,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
  return { root, stateDir, configPath, databasePath, config, begin };
}

function createDanglingWorkshopIndex(pathname: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(pathname);
  try {
    database
      .prepare(
        `INSERT INTO skill_workshop_collection_reviews (
         review_id, owner_agent_id, backup_id, create_time,
         kept_names_json, written_names_json, dropped_json
       ) VALUES ('review-preserved', 'main', 'backup-preserved', 1, '[]', '[]', '[]')`,
      )
      .run();
    database.exec(
      "CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
    );
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        `UPDATE sqlite_schema
          SET sql = 'CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
                       ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)'
        WHERE type = 'index'
          AND name = 'idx_skill_workshop_collection_reviews_workspace_time'`,
      )
      .run();
    const schema = database.prepare("PRAGMA schema_version").get() as { schema_version: number };
    database.exec(
      `PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schema.schema_version + 1};`,
    );
  } finally {
    database.close();
  }
}

it("admits a supported legacy registry without weakening runtime target validation", async () => {
  const fixture = createLegacyRegistryFixture();
  fs.writeFileSync(fixture.configPath, JSON.stringify(fixture.config));
  const before = fs.readFileSync(fixture.databasePath);
  const resolveRuntimeTargets = () =>
    resolveConfiguredAgentDatabaseTargets(fixture.config, { env: process.env });
  expect(resolveRuntimeTargets).toThrow("legacy agent database registry schema");
  const maintenance = await fixture.begin();
  try {
    expect(maintenance).toBeDefined();
    expect(fs.readFileSync(fixture.databasePath)).toEqual(before);
    expect(resolveRuntimeTargets).toThrow("legacy agent database registry schema");
  } finally {
    await maintenance?.release();
  }
});

it.each(["canonical", "custom-json", "shared-sqlite", "registered-shared-sqlite"] as const)(
  "refuses a newer %s database before repairing an old registry",
  async (layout) => {
    const fixture = createLegacyRegistryFixture();
    const customDir = path.join(fixture.root, "custom");
    const agentPath =
      layout === "canonical"
        ? path.join(fixture.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")
        : path.join(
            customDir,
            layout === "custom-json" ? "openclaw-agent.sqlite" : "sessions.sqlite",
          );
    if (layout !== "canonical") {
      fixture.config.session = {
        store: layout === "custom-json" ? path.join(customDir, "sessions.json") : agentPath,
      };
    }
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    if (layout === "registered-shared-sqlite") {
      fixture.config.agents!.entries!.ops = {};
      const registry = new DatabaseSync(fixture.databasePath);
      registry
        .prepare("INSERT INTO agent_databases VALUES (?, ?, ?, ?, ?)")
        .run("ops", agentPath, OPENCLAW_AGENT_SCHEMA_VERSION, 1, null);
      registry.close();
    }
    const agent = new DatabaseSync(agentPath);
    agent.exec(`
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};
      CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, agent_id TEXT);
      INSERT INTO schema_meta VALUES ('primary', 'main');
    `);
    agent.close();
    fs.writeFileSync(fixture.configPath, JSON.stringify(fixture.config));
    const paths = [fixture.configPath, fixture.databasePath, agentPath];
    const before = paths.map((pathname) => fs.readFileSync(pathname));

    await expect(
      runDoctorHealthFlow(
        { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        { repair: true, nonInteractive: true },
      ),
    ).rejects.toThrow(
      layout === "registered-shared-sqlite" ? "for agent ops" : "newer than this build",
    );
    expect(paths.map((pathname) => fs.readFileSync(pathname))).toEqual(before);
  },
);

it.each([
  "missing-index",
  "wrong-index",
  "missing-table",
  "dangling-workshop-index",
  "dangling-workshop-index-with-delivery-orphans",
] as const)("lets the schema repair owner decide current shared-state %s", async (damage) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const danglingWorkshopIndex =
      damage === "dangling-workshop-index" ||
      damage === "dangling-workshop-index-with-delivery-orphans";
    if (danglingWorkshopIndex) {
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
      };
      await state.writeConfig(config);
      mocks.config.mockReturnValue(config);
    }
    const initial = openOpenClawStateDatabase({ env: state.env });
    if (danglingWorkshopIndex) {
      expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
    }
    if (!danglingWorkshopIndex) {
      initial.db.exec(
        damage === "missing-table" ? "DROP TABLE task_runs" : "DROP INDEX idx_task_runs_status",
      );
    }
    if (damage === "wrong-index") {
      initial.db.exec("CREATE INDEX idx_task_runs_status ON task_runs(task_id)");
    }
    if (damage === "dangling-workshop-index-with-delivery-orphans") {
      initial.db.exec(`PRAGMA foreign_keys = OFF;
          INSERT INTO task_delivery_state(task_id, requester_origin_json, last_notified_event_at)
          VALUES ('missing-task', 'preserve orphan payload', 42)`);
    }
    closeOpenClawStateDatabaseForTest();
    if (danglingWorkshopIndex) {
      createDanglingWorkshopIndex(initial.path);
    }
    mocks.runContributions.mockImplementation(async (ctx) => {
      const result = repairOpenClawStateDatabaseSchema({ env: state.env });
      ctx.runtime.log([...result.changes, ...result.warnings].join("\n"));
    });
    const loadConfig = doctorConfigFlow.loadAndMaybeMigrateDoctorConfig;
    const configPreflight = danglingWorkshopIndex
      ? vi
          .spyOn(doctorConfigFlow, "loadAndMaybeMigrateDoctorConfig")
          .mockImplementationOnce(async (params) => {
            const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");
            const preflight = await runDoctorConfigPreflight({
              observe: false,
              repairPrefixedConfig: true,
              recoverCorruptTargetStore: true,
              doctorOnlyStateMigrations: true,
              preparePluginMetadataSnapshot: true,
            });
            expect(preflight.snapshot).toMatchObject({
              exists: true,
              valid: true,
              path: state.configPath,
            });
            return {
              ...(await loadConfig(params)),
              cfg: preflight.baseConfig,
              sourceConfigValid: preflight.snapshot.valid,
              path: preflight.snapshot.path,
            };
          })
      : undefined;
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    try {
      await runCommandWithRuntime(runtime, () =>
        runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
      );
      if (configPreflight) {
        expect(configPreflight).toHaveBeenCalledOnce();
      }
    } finally {
      configPreflight?.mockRestore();
    }

    const output = [...runtime.log.mock.calls, ...runtime.error.mock.calls].flat().join("\n");
    expect(mocks.runContributions, output).toHaveBeenCalledOnce();
    const { DatabaseSync } = requireNodeSqlite();
    const repaired = new DatabaseSync(initial.path, { readOnly: true });
    try {
      if (damage === "missing-table") {
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(output).toMatch(/persisted database readiness.*task_runs/);
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        expect(
          repaired.prepare("SELECT name FROM sqlite_schema WHERE name = 'task_runs'").get(),
        ).toBeUndefined();
      } else {
        expect(runtime.exit, output).not.toHaveBeenCalled();
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        expect(
          repaired.prepare("SELECT name FROM pragma_index_info('idx_task_runs_status')").all(),
        ).toEqual([{ name: "status" }]);
        if (danglingWorkshopIndex) {
          expect(
            repaired
              .prepare(
                `SELECT review_id, owner_agent_id, backup_id, create_time,
                        kept_names_json, written_names_json, dropped_json
                   FROM skill_workshop_collection_reviews`,
              )
              .all(),
          ).toEqual([
            {
              review_id: "review-preserved",
              owner_agent_id: "main",
              backup_id: "backup-preserved",
              create_time: 1,
              kept_names_json: "[]",
              written_names_json: "[]",
              dropped_json: "[]",
            },
          ]);
          expect(
            repaired
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name = 'idx_skill_workshop_collection_reviews_workspace_time'",
              )
              .get(),
          ).toBeUndefined();
          expect(repaired.prepare("PRAGMA integrity_check").all()).toEqual([
            { integrity_check: "ok" },
          ]);
          expect(repaired.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        }
        if (damage === "dangling-workshop-index-with-delivery-orphans") {
          const recoveryDirs = fs
            .readdirSync(path.dirname(initial.path))
            .filter((name) => name.startsWith("openclaw-task-delivery-recovery-"));
          expect(recoveryDirs).toHaveLength(1);
          const exported = fs.readFileSync(
            path.join(path.dirname(initial.path), recoveryDirs[0]!, "orphan-rows.jsonl"),
            "utf8",
          );
          expect(JSON.parse(exported)).toMatchObject({
            task_id: "missing-task",
            requester_origin_json: "preserve orphan payload",
            last_notified_event_at: "42",
          });
        }
      }
    } finally {
      repaired.close();
    }
  });
});
