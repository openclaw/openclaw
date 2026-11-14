import { expect, it } from "vitest";
import { loseFirstCronMutationReply } from "../../test/helpers/cron/runtime-mutation.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  writeConfigMachineState,
  writeConfigMachineStateInDatabase,
} from "../state/config-machine-state-write.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { expectNoMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
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
import { resolveCronStoreKeyInDatabase } from "./store/paths.js";

const config: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {}, helper: {} },
  },
};

const provision = (agent = "main", cfg = config, cadenceMs = 60_000) =>
  provisionDefaultProactiveJob(cfg, agent, { cadenceMs });
const readJobs = async (storePath: string) => (await loadCronJobsStore(storePath)).jobs;

it("invalidates retained summaries when provisioning commits but its reply is lost", async () => {
  await withOpenClawTestState({ label: "proactive-provision-lost-reply" }, async (state) => {
    const storePath = state.statePath("selected", "jobs.json");
    writeConfigMachineState("cron.store", storePath);
    await saveCronJobsStore(storePath, { version: 1, jobs: [] });
    const before = getCronJobsStoreRevision(storePath);
    const dropped = loseFirstCronMutationReply("cron.provisionDefaultProactive");
    try {
      await expect(provision()).rejects.toThrow();
      expect(dropped.wasDropped()).toBe(true);
      const after = getCronJobsStoreRevision(storePath);
      expect(await readDefaultProactiveJobsAsync(storePath, ["main"])).toHaveLength(1);
      expect(after).toBeGreaterThan(before);
    } finally {
      await dropped.close();
    }
  });
});

it("provisions only the ambient owner once in the selected partition without host SQL", async () => {
  await withOpenClawTestState({ label: "proactive-provision" }, async (state) => {
    const storePath = state.statePath("selected", "jobs.json");
    writeConfigMachineState("cron.store", storePath);
    await expectNoMainThreadSql(async () => {
      const before = getCronJobsStoreRevision(storePath);
      expect(
        await provision("main", {
          agents: { ownership: "explicit", entries: { main: {}, helper: {} } },
        }),
      ).toBeUndefined();
      expect(await provision("helper")).toBeUndefined();
      const job = await provision();
      expect(job).toMatchObject({
        agentId: "main",
        enabled: true,
        sessionTarget: "session:agent:main:main",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", skipIfScratchEmpty: true },
        delivery: { mode: "announce", target: "owner" },
      });
      expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
      expect(await provision("main", config, 120_000)).toEqual(job);
      expect(await readJobs(storePath)).toEqual([job]);
      expect(await readDefaultProactiveJobReceiptsAsync(undefined, ["main", "helper"])).toEqual({
        main: { jobId: job?.id, provisionedAtMs: job?.createdAtMs, phase: "complete" },
      });
      expect(await readDefaultProactiveJobsAsync(undefined, ["main"])).toEqual([job]);

      await saveCronJobsStore(storePath, { version: 1, jobs: [] });
      expect(await provision()).toBeUndefined();
      expect(await readJobs(storePath)).toEqual([]);
      expect((await readDefaultProactiveJobReceiptsAsync(undefined, ["main"])).main?.jobId).toBe(
        job?.id,
      );
    });
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
      runOpenClawStateWriteTransaction(({ db }) => {
        const storeKey = resolveCronStoreKeyInDatabase(db, storePath);
        writeConfigMachineStateInDatabase(db, `automation-default:${storeKey}:main`, {
          jobId: "recorded-job",
          provisionedAtMs: 1,
          phase,
        });
      });
      await expect(provision()).rejects.toThrow(expected);
      expect(await readJobs(storePath)).toEqual([]);
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
      const storeKey = resolveCronStoreKeyInDatabase(db, storePath);
      recordDefaultProactiveJobInDatabase(db, storeKey, "main", primary.id, 1);
      recordConvertedProactiveJobInDatabase(db, storeKey, "main", converted.id);
      recordDefaultProactiveJobInDatabase(db, storeKey, "helper", pending.id, 3, "pending");
    });
    await expectNoMainThreadSql(async () => {
      const jobs = await readDefaultProactiveJobsAsync(undefined, ["main", "helper"]);
      expect(jobs).toEqual([primary, converted]);
    });
  });
});
