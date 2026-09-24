import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { listAgentDatabaseAdmissionRefusals } from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

afterEach(() => cleanupSessionStateForTest());

const startupOptions = {
  migrateState: true,
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  requireStartupMigrationCheckpoint: true,
} as const;

async function withContainerState(run: (stateDir: string, workspace: string) => Promise<void>) {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const workspace = path.join(stateDir, "workspace");
    await writeOpenClawConfig(home, {
      gateway: { mode: "local" },
      plugins: { enabled: false },
      agents: { defaults: { workspace } },
    });
    fs.mkdirSync(workspace, { recursive: true });
    await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, () => run(stateDir, workspace));
  });
}

function seedSchema19Agent(stateDir: string, unsafe = false): string {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  const schema = fs.readFileSync(
    new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v19.sql", import.meta.url),
    "utf8",
  );
  expect(createHash("sha256").update(schema).digest("hex")).toBe(
    "fe93217454642e911608f81afc53c9fb3bb7c20cc32bc73f8f6eeaaf232b91b8",
  );
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  // The released installation has shared history before this immutable agent snapshot.
  openOpenClawStateDatabase({ env });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(schema);
    database.exec(`
      PRAGMA user_version = 19;
      INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
        VALUES ('primary', 'agent', 19, 'main', '2026.9.4', 1, 1);
    `);
    database
      .prepare(`INSERT INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)`)
      .run("agent:main:upgrade", "upgrade", JSON.stringify({ sessionId: "upgrade", updatedAt: 1 }));
    if (unsafe) {
      database.exec("UPDATE schema_meta SET schema_version = 18 WHERE meta_key = 'primary'");
    }
  } finally {
    database.close();
  }
  registerOpenClawAgentDatabase({ agentId: "main", path: databasePath, env, schemaVersion: 19 });
  closeOpenClawStateDatabaseForTest();
  return databasePath;
}

describe("container image replacement startup migrations", () => {
  it("migrates schema 19 under the startup lease before admitting the default agent", async () => {
    await withContainerState(async (stateDir) => {
      const databasePath = seedSchema19Agent(stateDir);
      let migrationLeaseObserved = false;
      await withAgentDatabaseStartupAdmission(async () => {
        await runDoctorConfigPreflight({
          ...startupOptions,
          measure: async (name, run) => {
            if (name === "doctor.config-preflight.legacy-state-migrations") {
              migrationLeaseObserved = hasActiveStartupMigrationLease();
            }
            return run();
          },
        });
        expect(listAgentDatabaseAdmissionRefusals()).toEqual([]);
      });
      expect(migrationLeaseObserved).toBe(true);
      const backups = fs
        .readdirSync(path.dirname(databasePath))
        .filter((name) => name.startsWith(`${path.basename(databasePath)}.pre-startup-migration-`));
      expect(backups).toHaveLength(1);
      const before = new DatabaseSync(path.join(path.dirname(databasePath), backups[0]!), {
        readOnly: true,
      });
      try {
        expect(before.prepare("PRAGMA user_version").get()?.user_version).toBe(19);
        expect(before.prepare("SELECT count(*) AS count FROM session_nodes").get()?.count).toBe(1);
      } finally {
        before.close();
      }
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(
          database
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get()?.schema_version,
        ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
        expect(
          database.prepare("SELECT session_key, current_session_id FROM session_nodes").all(),
        ).toEqual([{ session_key: "agent:main:upgrade", current_session_id: "upgrade" }]);
      } finally {
        database.close();
      }
    });
  });

  it("imports legacy workspace state and audit schema before runtime readiness", async () => {
    await withContainerState(async (stateDir, workspace) => {
      closeOpenClawStateDatabaseForTest();
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.writeFileSync(
        databasePath,
        gunzipSync(fs.readFileSync("test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz")),
      );
      const legacyPath = path.join(workspace, "openclaw-workspace-state.json");
      const setup = { version: 1, setupCompletedAt: "2026-07-02T00:00:00.000Z" };
      fs.writeFileSync(legacyPath, JSON.stringify(setup));
      await runDoctorConfigPreflight(startupOptions);
      expect((await readWorkspaceStateSnapshot(workspace)).setup).toEqual(setup);
      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(
        fs
          .readdirSync(workspace)
          .some((name) => name.startsWith("openclaw-workspace-state.json.migrated.")),
      ).toBe(true);
      const backups = fs
        .readdirSync(path.dirname(databasePath))
        .filter((name) => name.startsWith("openclaw.sqlite.pre-startup-migration-"));
      expect(backups).toHaveLength(1);
      const before = new DatabaseSync(path.join(path.dirname(databasePath), backups[0]!), {
        readOnly: true,
      });
      try {
        expect(before.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
        expect(before.prepare("SELECT count(*) AS count FROM state_leases").get()?.count).toBe(0);
      } finally {
        before.close();
      }
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
        expect(
          database
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get()?.schema_version,
        ).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      } finally {
        database.close();
      }
    });
  });

  it("isolates a divergent auxiliary database while migrating and admitting the default agent", async () => {
    await withContainerState(async (stateDir, workspace) => {
      await writeOpenClawConfig(path.dirname(stateDir), {
        gateway: { mode: "local" },
        plugins: { enabled: false },
        agents: {
          defaults: { workspace },
          entries: { main: { default: true }, auxiliary: {} },
        },
      });
      const mainPath = seedSchema19Agent(stateDir);
      const auxiliaryPath = path.join(
        stateDir,
        "agents",
        "auxiliary",
        "agent",
        "openclaw-agent.sqlite",
      );
      fs.mkdirSync(path.dirname(auxiliaryPath), { recursive: true });
      fs.copyFileSync(mainPath, auxiliaryPath, fs.constants.COPYFILE_EXCL);
      const auxiliary = new DatabaseSync(auxiliaryPath);
      try {
        auxiliary
          .prepare("UPDATE session_nodes SET entry_json = ?")
          .run(JSON.stringify({ sessionId: "upgrade", updatedAt: 1, label: "Unique history" }));
      } finally {
        auxiliary.close();
      }
      const preservedBytes = fs.readFileSync(auxiliaryPath);

      await withAgentDatabaseStartupAdmission(async () => {
        await runDoctorConfigPreflight(startupOptions);
        expect(listAgentDatabaseAdmissionRefusals()).toEqual([
          expect.objectContaining({
            agentId: "auxiliary",
            paths: [auxiliaryPath],
            embeddedOwnerId: "main",
            code: "agent-database-ownership-mismatch",
          }),
        ]);
      });

      expect(fs.readFileSync(auxiliaryPath)).toEqual(preservedBytes);
      expect(() => openOpenClawAgentDatabase({ agentId: "auxiliary" })).toThrow(
        "belongs to agent main",
      );
      const main = openOpenClawAgentDatabase({ agentId: "main" });
      expect(main.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      expect(
        main.db.prepare("SELECT session_key, current_session_id FROM session_nodes").all(),
      ).toEqual([{ session_key: "agent:main:upgrade", current_session_id: "upgrade" }]);
    });
  });

  it("exits 78 without migrating a core agent whose schema markers disagree", async () => {
    await withContainerState(async (stateDir) => {
      const databasePath = seedSchema19Agent(stateDir, true);
      await withAgentDatabaseStartupAdmission(async () => {
        await expect(runDoctorConfigPreflight(startupOptions)).rejects.toMatchObject({ code: 78 });
      });
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(19);
        expect(database.prepare("SELECT count(*) AS count FROM session_nodes").get()?.count).toBe(
          1,
        );
        expect(
          database
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get()?.schema_version,
        ).toBe(18);
      } finally {
        database.close();
      }
    });
  });
});
