import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareDoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { readAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.kernel.js";
import { beginAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

it("refreshes supplied missing-history discovery after maintenance admits a newer configured store", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const before: OpenClawConfig = { agents: { entries: { main: {} } } };
    await state.writeConfig(before);
    const mainPath = createLegacyDatabaseFixture({
      env: state.env,
      eventsBySession: {},
      schemaVersion: 19,
    });
    const lateDir = state.path("external-agent");
    const latePath = createLegacyDatabaseFixture({
      agentId: "late",
      env: state.env,
      eventsBySession: {},
      schemaVersion: 19,
      path: path.join(lateDir, "openclaw-agent.sqlite"),
    });
    unregisterOpenClawAgentDatabase({ agentId: "late", path: latePath, env: state.env });
    runOpenClawStateWriteTransaction(
      (database) => database.db.exec("DROP TABLE agent_deletion_journal"),
      { env: state.env },
    );
    closeOpenClawStateDatabaseForTest();
    const prepared = await prepareDoctorDatabasePreflight({ cfg: before });
    expect(
      prepared.agentDatabaseMigrationDiscovery?.discovery.unverifiedTargets.map(
        (target) => target.path,
      ),
    ).toEqual([mainPath]);

    const after: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, late: { agentDir: lateDir } } },
    };
    await state.writeConfig(after);
    const bytes = [mainPath, latePath].map((file) => fs.readFileSync(file));
    mocks.config.mockReturnValue(after);
    mocks.packageRoot.mockReturnValue(undefined);
    mocks.runContributions.mockReset();
    mocks.emulateNativeInstall = false;
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    try {
      await runDoctorHealthFlow(
        runtime,
        { repair: true, nonInteractive: true },
        undefined,
        prepared,
      );
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(
        readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env: state.env }))
          .map((target) => target.path)
          .toSorted(),
      ).toEqual([mainPath, latePath].toSorted());
      expect([mainPath, latePath].map((file) => fs.readFileSync(file))).toEqual(bytes);
    } finally {
      mocks.emulateNativeInstall = true;
      closeOpenClawStateDatabaseForTest();
    }
  });
});

it("keeps a newly quarantined pending deletion out of update reclamation", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" } },
    async (state) => {
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        gateway: { mode: "local" },
      };
      await state.writeConfig(cfg);
      const agentPath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      await closeOpenClawStateDatabaseAsync();
      const agent = openNodeSqliteDatabase(agentPath);
      try {
        agent.exec("PRAGMA auto_vacuum=NONE; VACUUM;");
        expect(agent.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(0);
      } finally {
        agent.close();
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
      runOpenClawStateWriteTransaction(
        (database) =>
          database.db.exec(
            "UPDATE agent_deletion_journal SET cleanup_paths_json = '[' WHERE agent_id = 'main'",
          ),
        { env: state.env },
      );
      await closeOpenClawStateDatabaseAsync();
      const bytes = fs.readFileSync(agentPath);
      const inode = fs.statSync(agentPath).ino;
      mocks.config.mockReturnValue(cfg);
      mocks.packageRoot.mockReturnValue(undefined);
      mocks.runContributions.mockReset();
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });

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
