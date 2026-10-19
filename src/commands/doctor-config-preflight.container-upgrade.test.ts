// Keep host service effects isolated while exercising the real Doctor repair flow.
import "../flows/doctor-health.test-support.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runDoctorHealthFlow } from "../flows/doctor-health.js";
import { readStartupMigrationWarning } from "../infra/state-migrations.messages.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import { listAgentDatabaseAdmissionRefusals } from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import * as configFlow from "./doctor-config-flow.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const { mocks } = await import("../flows/doctor-health.test-support.js");
beforeEach(async () => {
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.runContributions.mockReset().mockResolvedValue(undefined);
  const actual =
    await vi.importActual<typeof import("./doctor-config-flow.js")>("./doctor-config-flow.js");
  vi.spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig").mockImplementation((params) => {
    expect(getOpenClawDatabaseMaintenanceScope()).toBeDefined();
    return actual.loadAndMaybeMigrateDoctorConfig(params);
  });
});
afterEach(async () => {
  await cleanupSessionStateForTest();
  vi.restoreAllMocks();
});

async function repairContainerState() {
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
  expect(runtime.exit, runtime.error.mock.calls.flat().join("\n")).not.toHaveBeenCalled();
}

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

describe("container image replacement Doctor repair and startup readiness", () => {
  it("preserves schema 19 at startup, then backs it up and repairs it through Doctor", async () => {
    await withContainerState(async (stateDir) => {
      const databasePath = seedSchema19Agent(stateDir);
      const original = fs.readFileSync(databasePath);
      await withAgentDatabaseStartupAdmission(
        async () => {
          await expect(runStartupConfigPreflight({ gateway: true })).rejects.toMatchObject({
            code: 78,
          });
          expect(fs.readFileSync(databasePath)).toEqual(original);
          await repairContainerState();
          await runStartupConfigPreflight({ gateway: true });
          expect(listAgentDatabaseAdmissionRefusals()).toEqual([]);
        },
        { deferInspections: false },
      );
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
      await cleanupSessionStateForTest();
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const inspect = () => inspectSessionSqliteRecovery({ cfg: {}, env });
      const protectedBackups = inspect();
      expect(protectedBackups.artifacts).toHaveLength(2);
      expect(
        protectedBackups.artifacts.every(
          (item) =>
            item.outcome === "protected" && item.reason === "awaiting-later-completed-update",
        ),
      ).toBe(true);
      const legacyBackup = `${databasePath}.pre-startup-migration-legacy.bak`;
      fs.writeFileSync(legacyBackup, "older unrecorded backup");
      // Session archives and schema backups share a destination and the cleanup verifier.
      const store = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      fs.mkdirSync(path.dirname(store), { recursive: true });
      fs.writeFileSync(store, "{}");
      await runDoctorSessionSqlite({ env, cfg: {}, agent: "main", store, mode: "import" });
      await cleanupSessionStateForTest();
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
      try {
        const later = createUpdateRun({ trigger: "cli" }, { env });
        expect(
          inspect().artifacts.filter(
            (item) => item.path.endsWith(".bak") && item.outcome === "candidate",
          ),
        ).toHaveLength(0);
        finishUpdateRun(later.runId, { status: "succeeded" }, { env });
      } finally {
        clock.mockRestore();
      }
      await cleanupSessionStateForTest();
      const preview = inspect();
      expect(preview.artifacts.filter((item) => item.outcome === "candidate")).toHaveLength(3);
      expect(preview.artifacts).toContainEqual(
        expect.objectContaining({
          path: legacyBackup,
          outcome: "protected",
          reason: "unmanifested-recovery-original",
        }),
      );
      const retired = await retireSessionSqliteRecovery({
        env,
        preview,
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(retired.status).toBe("complete");
      expect(retired.totals.removedFiles).toBe(3);
      expect(fs.existsSync(legacyBackup)).toBe(true);
      expect(fs.existsSync(databasePath)).toBe(true);
    });
  });

  it("leaves legacy workspace and audit state untouched until Doctor repairs them", async () => {
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
      const original = fs.readFileSync(databasePath);
      await expect(runStartupConfigPreflight({ gateway: true })).rejects.toMatchObject({
        code: 78,
      });
      expect(fs.readFileSync(databasePath)).toEqual(original);
      expect(fs.readFileSync(legacyPath, "utf8")).toBe(JSON.stringify(setup));

      await repairContainerState();
      await runStartupConfigPreflight({ gateway: true });
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
        auxiliary.exec(
          "PRAGMA foreign_keys=OFF; CREATE TABLE probe_parent(id INTEGER PRIMARY KEY); CREATE TABLE probe_child(parent_id REFERENCES probe_parent(id)); INSERT INTO probe_child VALUES (42);",
        );
        auxiliary
          .prepare("UPDATE session_nodes SET entry_json = ?")
          .run(JSON.stringify({ sessionId: "upgrade", updatedAt: 1, label: "Unique history" }));
      } finally {
        auxiliary.close();
      }
      const preservedBytes = fs.readFileSync(auxiliaryPath);

      await repairContainerState();
      expect(fs.readFileSync(auxiliaryPath)).toEqual(preservedBytes);
      expect(
        fs
          .readdirSync(path.dirname(auxiliaryPath))
          .filter((name) => name.includes("pre-startup-migration")),
      ).toEqual([]);
      const main = openOpenClawAgentDatabase({ agentId: "main" });
      expect(main.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      expect(
        main.db.prepare("SELECT session_key, current_session_id FROM session_nodes").all(),
      ).toEqual([{ session_key: "agent:main:upgrade", current_session_id: "upgrade" }]);

      const retiredPath = path.join(stateDir, "settings", "voicewake.json");
      const retiredBytes = '{"triggers":["leave-for-doctor"]}\n';
      fs.mkdirSync(path.dirname(retiredPath), { recursive: true });
      fs.writeFileSync(retiredPath, retiredBytes);
      await withAgentDatabaseStartupAdmission(
        async () => {
          await runStartupConfigPreflight({ gateway: true });
          expect(listAgentDatabaseAdmissionRefusals()).toEqual([
            expect.objectContaining({
              agentId: "auxiliary",
              paths: [auxiliaryPath],
              embeddedOwnerId: "main",
              code: "agent-database-ownership-mismatch",
            }),
          ]);
          expect(readStartupMigrationWarning()).toContain("belongs to agent main");
          expect(readStartupMigrationWarning()).toContain(
            "Preserve and inspect this database before accepting a fresh agent.",
          );
          expect(readStartupMigrationWarning()).toContain(retiredPath);
        },
        { deferInspections: false },
      );

      expect(fs.readFileSync(auxiliaryPath)).toEqual(preservedBytes);
      expect(fs.readFileSync(retiredPath, "utf8")).toBe(retiredBytes);
      expect(() => openOpenClawAgentDatabase({ agentId: "auxiliary" })).toThrow(
        "belongs to agent main",
      );
    });
  });

  it("refuses startup and Doctor repair when a core agent schema has conflicting markers", async () => {
    await withContainerState(async (stateDir) => {
      const databasePath = seedSchema19Agent(stateDir, true);
      const original = fs.readFileSync(databasePath);
      await withAgentDatabaseStartupAdmission(async () => {
        await expect(runStartupConfigPreflight({ gateway: true })).rejects.toMatchObject({
          code: 78,
        });
      });
      expect(fs.readFileSync(databasePath)).toEqual(original);
      await expect(repairContainerState()).rejects.toMatchObject({
        name: "DoctorStateMigrationRefusalError",
        stepReceipts: expect.arrayContaining([
          expect.objectContaining({
            id: "media-persistence",
            outcome: "refused",
            refusal: { code: "step-refused", message: expect.any(String) },
            warnings: expect.arrayContaining([
              expect.stringContaining(
                `${databasePath} metadata schema version 18 does not match 19`,
              ),
            ]),
          }),
          expect.objectContaining({
            id: "transcript-directives",
            refusal: expect.objectContaining({ code: "blocked-by-prior-refusal" }),
          }),
        ]),
      });
      expect(fs.readFileSync(databasePath)).toEqual(original);
      await withAgentDatabaseStartupAdmission(async () => {
        await expect(runStartupConfigPreflight({ gateway: true })).rejects.toMatchObject({
          code: 78,
        });
      });
      expect(fs.readFileSync(databasePath)).toEqual(original);
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
