import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDefaultProactiveJob } from "../cron/default-proactive-job.js";
import { saveProactiveJobsForTest } from "../cron/proactive-job.test-support.js";
import { saveCronJobsStore } from "../cron/store.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  projectHeartbeatSummary,
  readHeartbeatSummaryForStatus,
  readHeartbeatSummarySnapshot,
} from "./heartbeat-summary-snapshot.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

it("keeps diagnostics available and reports paused cron when partition selection is unresolved", async () => {
  await withOpenClawTestState({ label: "heartbeat-unresolved-partition" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {} },
      },
    };
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

it("reuses the selected partition without rereading its selection and observes committed changes", async () => {
  await withOpenClawTestState({ label: "heartbeat-selected-partition" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {} },
      },
    };
    const selectedPath = state.statePath("selected", "jobs.json");
    const defaultPath = state.statePath("default", "jobs.json");
    const selectedJob = {
      ...createDefaultProactiveJob(cfg, "main", 1),
      id: "selected-job",
      name: "Selected partition",
    };
    const defaultJob = {
      ...createDefaultProactiveJob(cfg, "main", 1),
      id: "default-job",
      name: "Default partition",
    };
    await saveProactiveJobsForTest(selectedPath, [selectedJob]);
    await saveProactiveJobsForTest(defaultPath, [defaultJob]);
    writeConfigMachineState("cron.store", defaultPath);
    await closeStateDatabaseForTest();

    const trace = state.path("statement-counts.txt");
    const preload = state.path("observe-summary-statements.cjs");
    await fs.writeFile(trace, "");
    // Read-only SQLite handles bypass engine observation. Count native execution
    // in the real worker, including reuse of statements prepared by an earlier read.
    // Only bucket names leave the worker; SQL, bindings and returned rows do not.
    await fs.writeFile(
      preload,
      `const fs = require("node:fs");
const { isMainThread } = require("node:worker_threads");
if (!isMainThread) {
  const { DatabaseSync } = require("node:sqlite");
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = Reflect.apply(prepare, this, [sql]);
    const bucket = /^select\\b/i.test(sql)
      ? /\\bfrom\\s+"config_machine_state"/i.test(sql) ? "machine"
        : /\\bfrom\\s+"cron_jobs"/i.test(sql) ? "jobs" : undefined
      : undefined;
    if (bucket) {
      for (const method of ["get", "all", "run", "iterate"]) {
        const execute = statement[method];
        statement[method] = function(...args) {
          const result = Reflect.apply(execute, this, args);
          fs.appendFileSync(${JSON.stringify(trace)}, bucket + "\\n");
          return result;
        };
      }
    }
    return statement;
  };
}
`,
    );

    await withEnvAsync(sqliteWorkerPreloadEnv(preload), async () => {
      try {
        // Admit the real read worker before measuring its steady-state work.
        await readHeartbeatSummarySnapshot(cfg);
        const read = async (storePath?: string) => {
          await fs.writeFile(trace, "");
          const jobs = await readHeartbeatSummarySnapshot(cfg, storePath);
          const buckets = (await fs.readFile(trace, "utf8")).trim().split("\n");
          return {
            jobs,
            counts: {
              machine: buckets.filter((bucket) => bucket === "machine").length,
              jobs: buckets.filter((bucket) => bucket === "jobs").length,
            },
          };
        };

        const selected = await read(selectedPath);
        // One receipt read remains; selecting cron.store would add a second read.
        expect(selected.counts).toEqual({ machine: 1, jobs: 1 });
        expect(selected.jobs).toEqual([selectedJob]);

        const changedJob = {
          ...selectedJob,
          name: "Selected partition updated",
          enabled: false,
          updatedAtMs: 2,
        };
        await saveCronJobsStore(selectedPath, { version: 1, jobs: [changedJob] });
        const changed = await read(selectedPath);
        expect(changed.jobs).toEqual([changedJob]);
        expect(changed.counts).toEqual({ machine: 1, jobs: 1 });

        const fallback = await read();
        expect(fallback.jobs).toEqual([defaultJob]);
        expect(fallback.counts).toEqual({ machine: 2, jobs: 1 });

        writeConfigMachineState("cron.store", selectedPath);
        const reselection = await read();
        expect(reselection.jobs).toEqual([changedJob]);
        expect(reselection.counts).toEqual({ machine: 2, jobs: 1 });
      } finally {
        // Join workers before restoring the preload environment or deleting its files.
        await closeStateDatabaseForTest();
      }
    });
  });
});
