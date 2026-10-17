import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.kernel.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withEnvAsync } from "../test-utils/env.js";
import { repairDoctorAgentDeletionJournal } from "./doctor-agent-deletion-journal.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function withFixture(
  run: (fixture: {
    env: NodeJS.ProcessEnv;
    agentPath: string;
    sharedPath: string;
  }) => Promise<void>,
) {
  const root = fs.realpathSync.native(dirs.make("doctor-published-journal-"));
  const env = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_HOME: root,
    OPENCLAW_AGENT_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
  };
  await withEnvAsync(env, async () => {
    fs.writeFileSync(
      env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({
        agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
        plugins: { enabled: false },
      }),
    );
    const sharedPath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const agentPath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    using agent = new DatabaseSync(agentPath);
    agent.exec(
      fs.readFileSync(
        new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v24.sql", import.meta.url),
        "utf8",
      ),
    );
    agent.exec("PRAGMA user_version = 24");
    agent
      .prepare(
        "INSERT INTO schema_meta VALUES ('primary', 'agent', 24, 'main', '2026.10.4', 1000, 1000)",
      )
      .run();
    agent
      .prepare(
        "INSERT INTO cache_entries(scope, key, value_json, updated_at) VALUES ('user', 'preserved', ?, 1000)",
      )
      .run('{"bytes":"preserved 🦞"}');
    agent.close();
    await run({ env, agentPath, sharedPath });
  });
}

async function repair(env: NodeJS.ProcessEnv) {
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
  });
  try {
    return await maintenance.run(async () =>
      repairDoctorAgentDeletionJournal({
        preflight: await prepareDoctorDatabasePreflight(),
        shouldRepair: true,
        env,
      }),
    );
  } finally {
    await maintenance.close();
  }
}

it.each(["first-upgrade", "already-held"])(
  "restores a populated published store with verified backups on %s",
  async (phase) => {
    await withFixture(async ({ env, agentPath, sharedPath }) => {
      using shared = new DatabaseSync(sharedPath);
      shared.exec("DROP TABLE agent_deletion_journal");
      shared.close();
      const bytes = fs.readFileSync(agentPath);
      if (phase === "already-held") {
        // The old Doctor owner produces a real reconstruction receipt; remove only
        // the new optional observation field to exercise the published format.
        await repairDoctorAgentDeletionJournal({
          preflight: await prepareDoctorDatabasePreflight(),
          shouldRepair: true,
          env,
        });
        const state = openOpenClawStateDatabase({ env });
        const row = state.db
          .prepare(
            "SELECT report_json FROM migration_sources WHERE source_key = 'agent-deletion-journal-reconstruction'",
          )
          .get();
        const report = JSON.parse(String(row?.report_json));
        delete report.missingJournal;
        state.db
          .prepare(
            "UPDATE migration_sources SET report_json = ? WHERE source_key = 'agent-deletion-journal-reconstruction'",
          )
          .run(JSON.stringify(report));
      }
      const result = await repair(env);
      expect(result.warnings.join("\n")).toContain("Automatically restored agent main");
      expect(result.warnings.join("\n")).toContain("Verified backup:");
      expect(readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env }))).toEqual([]);
      expect(fs.readFileSync(agentPath)).toEqual(bytes);
      const backups = result.changes
        .filter((change) => change.startsWith("Saved pre-migration SQLite backup: "))
        .map((change) => change.slice("Saved pre-migration SQLite backup: ".length));
      expect(backups).toHaveLength(2);
      for (const backup of backups) {
        using database = new DatabaseSync(backup, { readOnly: true });
        expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        if (backup.startsWith(agentPath)) {
          expect(
            database.prepare("SELECT value_json FROM cache_entries WHERE key='preserved'").get()
              ?.value_json,
          ).toBe('{"bytes":"preserved 🦞"}');
        } else {
          expect(
            database
              .prepare(
                "SELECT report_json FROM migration_sources WHERE source_key = 'agent-deletion-journal-reconstruction'",
              )
              .get()?.report_json,
          ).toContain('"agentId":"main"');
          expect(
            database.prepare("SELECT count(*) AS n FROM migration_runs").get()?.n,
          ).toBeGreaterThan(0);
        }
      }
      expect(await repair(env)).toEqual({ changes: [], warnings: [] });
    });
  },
);

it.each(["present-incomplete", "other-version", "rewritten-stamp"])(
  "keeps %s stores held",
  async (kind) => {
    await withFixture(async ({ env, agentPath, sharedPath }) => {
      using shared = new DatabaseSync(sharedPath);
      if (kind === "present-incomplete") {
        beginAgentDeletionJournal(
          {
            agentId: "main",
            operationId: "lost-history",
            agentDir: path.dirname(agentPath),
            workspaceDir: path.join(env.OPENCLAW_STATE_DIR!, "workspace"),
            sessionsDir: path.join(env.OPENCLAW_STATE_DIR!, "agents/main/sessions"),
            databasePaths: [agentPath],
            deleteFiles: false,
          },
          { env },
        );
        shared.exec(
          "UPDATE agent_deletion_journal SET database_paths_json = '[' WHERE agent_id = 'main'",
        );
      } else {
        shared.exec("DROP TABLE agent_deletion_journal");
      }
      shared.close();
      if (kind !== "present-incomplete") {
        using agent = new DatabaseSync(agentPath);
        agent.exec(
          kind === "other-version"
            ? "UPDATE schema_meta SET app_version = '2026.9.6'"
            : "UPDATE schema_meta SET updated_at = 2000",
        );
      }
      const bytes = fs.readFileSync(agentPath);
      const result = await repair(env);
      expect(result.warnings.join("\n")).not.toContain("Automatically restored");
      expect(result.warnings.join("\n")).toContain("held back");
      expect(result.warnings.join("\n")).toContain("agents add");
      expect(readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env }))).toContainEqual({
        agentId: "main",
        path: agentPath,
      });
      expect(fs.readFileSync(agentPath)).toEqual(bytes);
      await expect(
        assertOpenClawDatabasesReady({
          env,
          operation: "doctor",
          config: { agents: { entries: { main: {} } } },
          configuredAgentDatabaseTargets: [{ agentId: "main", path: agentPath }],
        }),
      ).rejects.toThrow("Doctor could not complete repair");
    });
  },
);
