import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareDoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { readAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.kernel.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks, createDoctorRuntime, createDoctorConfig } =
  await import("./doctor-health.test-support.js");
const repairOptions = { repair: true, nonInteractive: true };
function execState(sql: string, env: NodeJS.ProcessEnv) {
  runOpenClawStateWriteTransaction((database) => database.db.exec(sql), { env });
}

it("refreshes supplied missing-history discovery after maintenance admits a newer configured store", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const before: OpenClawConfig = { agents: { entries: { main: {} } } };
    await state.writeConfig(before);
    const legacy = { env: state.env, eventsBySession: {}, schemaVersion: 19 };
    const mainPath = createLegacyDatabaseFixture(legacy);
    const lateDir = state.path("external-agent");
    const latePath = createLegacyDatabaseFixture({
      agentId: "late",
      ...legacy,
      path: path.join(lateDir, "openclaw-agent.sqlite"),
    });
    unregisterOpenClawAgentDatabase({ agentId: "late", path: latePath, env: state.env });
    execState("DROP TABLE agent_deletion_journal", state.env);
    closeOpenClawStateDatabaseForTest();
    const prepared = await prepareDoctorDatabasePreflight({ cfg: before });
    const targets = prepared.agentDatabaseMigrationDiscovery?.discovery.unverifiedTargets;
    expect(targets?.map((target) => target.path)).toEqual([mainPath]);

    const after: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, late: { agentDir: lateDir } } },
    };
    await state.writeConfig(after);
    const bytes = [mainPath, latePath].map((file) => fs.readFileSync(file));
    mocks.config.mockReturnValue(after);
    mocks.packageRoot.mockReturnValue(undefined);
    mocks.runContributions.mockReset();
    mocks.emulateNativeInstall = false;
    const configFlow = await import("../commands/doctor-config-flow.js");
    const loadConfig = vi.spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig");
    const runtime = createDoctorRuntime();
    try {
      await expect(
        runDoctorHealthFlow(runtime, repairOptions, undefined, prepared),
      ).rejects.toMatchObject({
        name: "DoctorMaintenanceRefusalError",
        refusal: { kind: "data-at-risk", reason: "incomplete-migration" },
      });
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(loadConfig).toHaveBeenCalledOnce();
      expect(
        loadConfig.mock.calls[0]?.[0].agentDatabaseMigrationDiscovery?.discovery.targets
          .map(({ agentId, path: databasePath, source }) => ({
            agentId,
            path: databasePath,
            source,
          }))
          .toSorted((left, right) => left.agentId.localeCompare(right.agentId)),
      ).toEqual([
        { agentId: "late", path: latePath, source: "configured" },
        { agentId: "main", path: mainPath, source: "configured" },
      ]);
      expect([mainPath, latePath].map((file) => fs.readFileSync(file))).toEqual(bytes);
    } finally {
      loadConfig.mockRestore();
      mocks.emulateNativeInstall = true;
      closeOpenClawStateDatabaseForTest();
    }
  });
});

it("keeps a newly quarantined pending deletion out of update reclamation", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" } },
    async (state) => {
      const cfg = createDoctorConfig(state);
      await state.writeConfig(cfg);
      const agentPath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      await closeOpenClawStateDatabaseAsync();
      {
        using agent = openNodeSqliteDatabase(agentPath);
        agent.exec("PRAGMA auto_vacuum=NONE; VACUUM;");
        expect(agent.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(0);
      }
      beginAgentDeletionJournal(
        {
          agentId: "main",
          operationId: "interrupted-deletion",
          agentDir: path.dirname(agentPath),
          workspaceDir: state.workspaceDir,
          sessionsDir: path.join(state.stateDir, "agents", "main", "sessions"),
          databasePaths: [agentPath],
          deleteFiles: false,
        },
        { env: state.env },
      );
      execState(
        "UPDATE agent_deletion_journal SET cleanup_paths_json = '[' WHERE agent_id = 'main'",
        state.env,
      );
      await closeOpenClawStateDatabaseAsync();
      const bytes = fs.readFileSync(agentPath);
      const inode = fs.statSync(agentPath).ino;
      mocks.config.mockReturnValue(cfg);
      mocks.packageRoot.mockReturnValue(process.cwd());
      mocks.runContributions.mockReset();
      const runtime = createDoctorRuntime();

      await runDoctorHealthFlow(runtime, repairOptions);

      expect(runtime.exit).not.toHaveBeenCalled();
      expect(readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env: state.env }))).toEqual(
        [{ agentId: "main", path: agentPath }],
      );
      expect(runtime.log.mock.calls.flat().join("\n")).toContain(agentPath);
      expect(fs.readFileSync(agentPath)).toEqual(bytes);
      expect(fs.statSync(agentPath).ino).toBe(inode);
    },
  );
});
