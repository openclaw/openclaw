import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareDoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { readAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
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
      await expect(
        runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }, undefined, prepared),
      ).rejects.toThrow("Failing check agent-deletion-journal");
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
