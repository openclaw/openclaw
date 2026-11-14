import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDefaultProactiveJob } from "../cron/default-proactive-job.js";
import { saveProactiveJobsForTest } from "../cron/proactive-job.test-support.js";
import { saveCronJobsStore } from "../cron/store.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  projectHeartbeatSummary,
  readHeartbeatSummaryForStatus,
  readHeartbeatSummarySnapshot,
} from "./heartbeat-summary-snapshot.js";

const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {} },
  },
};

it("keeps diagnostics available and reports paused cron when partition selection is unresolved", async () => {
  await withOpenClawTestState({ label: "heartbeat-unresolved-partition" }, async (state) => {
    try {
      const storePath = state.path("old-state", "cron", "jobs.json");
      await saveProactiveJobsForTest(storePath, [createDefaultProactiveJob(cfg, "main", 1)]);
      openOpenClawStateDatabase()
        .db.prepare("DELETE FROM config_machine_state WHERE state_key = 'cron.defaultStoreKey'")
        .run();
      await closeStateDatabaseForTest();

      const summary = await readHeartbeatSummaryForStatus(() => readHeartbeatSummarySnapshot(cfg));
      expect(summary.jobs).toEqual([]);
      expect(summary.selectionWarning).toContain("openclaw doctor --fix");
      expect(summary.selectionWarning).toContain("Partition inventory:");
      expect(summary.selectionWarning).toContain(JSON.stringify(storePath));
      expect(projectHeartbeatSummary(undefined, summary.selectionWarning)).toMatchObject({
        enabled: false,
        every: "paused",
        prompt: summary.selectionWarning,
      });
      await expect(readHeartbeatSummarySnapshot(cfg)).rejects.toMatchObject({
        code: "CRON_STORE_SELECTION_REQUIRED",
      });
    } finally {
      await closeStateDatabaseForTest();
    }
  });
});

it("reads the selected partition and observes committed jobs and default selection changes", async () => {
  await withOpenClawTestState({ label: "heartbeat-selected-partition" }, async (state) => {
    const selectedPath = state.statePath("selected", "jobs.json");
    const defaultPath = state.statePath("default", "jobs.json");
    const job = createDefaultProactiveJob(cfg, "main", 1);
    const selectedJob = { ...job, id: "selected-job", name: "Selected partition" };
    const defaultJob = { ...job, id: "default-job", name: "Default partition" };
    await saveProactiveJobsForTest(selectedPath, [selectedJob]);
    await saveProactiveJobsForTest(defaultPath, [defaultJob]);
    writeConfigMachineState("cron.store", defaultPath);
    await closeStateDatabaseForTest();

    try {
      const expectRead = async (jobs: (typeof job)[], storePath?: string) => {
        expect(await readHeartbeatSummarySnapshot(cfg, storePath)).toEqual(jobs);
      };
      await expectRead([selectedJob], selectedPath);

      const changedJob = {
        ...selectedJob,
        name: "Selected partition updated",
        enabled: false,
        updatedAtMs: 2,
      };
      await saveCronJobsStore(selectedPath, { version: 1, jobs: [changedJob] });
      await expectRead([changedJob], selectedPath);
      await expectRead([defaultJob]);

      writeConfigMachineState("cron.store", selectedPath);
      await expectRead([changedJob]);
    } finally {
      await closeStateDatabaseForTest();
    }
  });
});
