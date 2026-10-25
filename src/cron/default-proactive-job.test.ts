import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createDefaultProactiveJob,
  provisionDefaultProactiveJob,
} from "./default-proactive-job.js";
import {
  readDefaultProactiveJobReceiptsAsync,
  readDefaultProactiveJobsAsync,
  recordConvertedProactiveJobInDatabase,
  recordDefaultProactiveJobInDatabase,
} from "./proactive-job-receipt.js";
import { getCronJobsStoreRevision, loadCronJobsStore, saveCronJobsStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";

const config: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {}, helper: {} },
  },
};

it("provisions only the ambient owner once in the selected partition without host SQL", async () => {
  await withOpenClawTestState({ label: "proactive-provision" }, async (state) => {
    const storePath = state.statePath("selected", "jobs.json");
    writeConfigMachineState("cron.store", storePath);
    const sql = observeMainThreadSql();
    try {
      const before = getCronJobsStoreRevision(storePath);
      expect(
        await provisionDefaultProactiveJob(
          { agents: { ownership: "explicit", entries: { main: {}, helper: {} } } },
          "main",
          { cadenceMs: 60_000 },
        ),
      ).toBeUndefined();
      expect(
        await provisionDefaultProactiveJob(config, "helper", { cadenceMs: 60_000 }),
      ).toBeUndefined();
      const job = await provisionDefaultProactiveJob(config, "main", { cadenceMs: 60_000 });
      expect(job).toMatchObject({
        agentId: "main",
        enabled: true,
        sessionTarget: "session:agent:main:main",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", skipIfScratchEmpty: true },
        delivery: { mode: "announce", target: "owner" },
      });
      expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
      expect(await provisionDefaultProactiveJob(config, "main", { cadenceMs: 120_000 })).toEqual(
        job,
      );
      expect((await loadCronJobsStore(storePath)).jobs).toEqual([job]);
      expect(await readDefaultProactiveJobReceiptsAsync(undefined, ["main", "helper"])).toEqual({
        main: { jobId: job?.id, provisionedAtMs: job?.createdAtMs, phase: "complete" },
      });
      expect(await readDefaultProactiveJobsAsync(undefined, ["main"])).toEqual([job]);

      await saveCronJobsStore(storePath, { version: 1, jobs: [] });
      expect(
        await provisionDefaultProactiveJob(config, "main", { cadenceMs: 60_000 }),
      ).toBeUndefined();
      expect((await loadCronJobsStore(storePath)).jobs).toEqual([]);
      expect((await readDefaultProactiveJobReceiptsAsync(undefined, ["main"])).main?.jobId).toBe(
        job?.id,
      );
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it.each([
  { phase: "pending", expected: "Proactive migration is incomplete" },
  { phase: "broken", expected: "Invalid default automation cutover receipt" },
])(
  "refuses provisioning for a $phase cutover without recreating jobs",
  async ({ phase, expected }) => {
    await withOpenClawTestState({ label: "proactive-cutover-refusal" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      writeConfigMachineState(`automation-default:${cronStoreKey(storePath)}:main`, {
        jobId: "recorded-job",
        provisionedAtMs: 1,
        phase,
      });
      await expect(
        provisionDefaultProactiveJob(config, "main", { cadenceMs: 60_000 }),
      ).rejects.toThrow(expected);
      expect((await loadCronJobsStore(storePath)).jobs).toEqual([]);
    });
  },
);

it("reports complete receipt jobs primary-first while excluding incomplete cutovers", async () => {
  await withOpenClawTestState({ label: "proactive-receipt-jobs" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const primary = createDefaultProactiveJob(config, "main", 1);
    const converted = { ...createDefaultProactiveJob(config, "main", 2), name: "Converted task" };
    const pending = createDefaultProactiveJob(config, "helper", 3);
    await saveCronJobsStore(storePath, { version: 1, jobs: [converted, pending, primary] });
    runOpenClawStateWriteTransaction(({ db }) => {
      recordDefaultProactiveJobInDatabase(db, storePath, "main", primary.id, 1);
      recordConvertedProactiveJobInDatabase(db, storePath, "main", converted.id);
      recordDefaultProactiveJobInDatabase(db, storePath, "helper", pending.id, 3, "pending");
    });
    const sql = observeMainThreadSql();
    try {
      expect(await readDefaultProactiveJobsAsync(undefined, ["main", "helper"])).toEqual([
        primary,
        converted,
      ]);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});
