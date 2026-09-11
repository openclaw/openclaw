import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runDoctorConfigPreflight } from "../commands/doctor-config-preflight.js";
import { prepareCronOwnerWriteRefusal } from "../config/io.cron-owner-refusal.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeCronJobScratch } from "./scratch-store.js";
import {
  loadCronJobsStoreSync,
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreWithConfigJobsReadOnly,
  saveCronJobsStore,
} from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob } from "./types.js";

function job(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    agentId: "main",
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
  };
}

function legacyReviewJob() {
  return {
    ...job("retired"),
    name: "skill-collection-review-main",
    declarationKey: "skill-collection-review:main",
    systemOwned: true,
    payload: { kind: "skillCollectionReview" },
  };
}

describe("retired Workshop cron jobs", () => {
  it.each(
    ["async", "sync"].flatMap((mode) =>
      ["both", "json-only", "column-only"].map((shape) => ({ mode, shape })),
    ),
  )(
    "retires $shape legacy rows on an already-current database through $mode load",
    async ({ mode, shape }) => {
      await withOpenClawTestState({ label: "retired-workshop-cron" }, async (state) => {
        const storePath = state.statePath("cron", "jobs.json");
        const otherStorePath = state.statePath("other-cron", "jobs.json");
        const retired = legacyReviewJob();
        await saveCronJobsStore(storePath, { version: 1, jobs: [job("retired"), job("keep")] });
        await saveCronJobsStore(otherStorePath, { version: 1, jobs: [job("retired")] });
        for (const target of [storePath, otherStorePath]) {
          writeCronJobScratch({
            storePath: target,
            jobId: "retired",
            content: "old scratch",
            nowMs: 1,
          });
        }
        const db = openOpenClawStateDatabase().db;
        const version = db.prepare("PRAGMA user_version").get();
        db.prepare("UPDATE cron_jobs SET payload_kind = ?, job_json = ? WHERE job_id = ?").run(
          shape === "json-only" ? "systemEvent" : "skillCollectionReview",
          JSON.stringify(shape === "column-only" ? job("retired") : retired),
          "retired",
        );
        const count = (table: "cron_jobs" | "cron_job_scratch", target: string) =>
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM " + table + " WHERE store_key = ? AND job_id = ?",
            )
            .get(cronStoreKey(target), "retired");

        const readOnly = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
        expect(readOnly.invalidConfigRows).toEqual([]);
        expect(readOnly.store.jobs.map((entry) => entry.id)).toEqual(["keep"]);
        expect(readOnly.configJobs.map((entry) => entry.id)).toEqual(["keep"]);
        const guard = await prepareCronOwnerWriteRefusal({}, { storePath, env: state.env });
        await guard.recheck();
        expect(count("cron_jobs", storePath)).toEqual({ count: 1 });
        expect(count("cron_job_scratch", storePath)).toEqual({ count: 1 });
        const loaded =
          mode === "sync"
            ? loadCronJobsStoreSync(storePath)
            : (await loadCronJobsStoreWithConfigJobs(storePath)).store;
        expect(loaded.jobs.map((entry) => entry.id)).toEqual(["keep"]);
        expect(count("cron_jobs", storePath)).toEqual({ count: 0 });
        expect(count("cron_job_scratch", storePath)).toEqual({ count: 0 });
        expect(count("cron_jobs", otherStorePath)).toEqual({ count: 1 });
        expect(count("cron_job_scratch", otherStorePath)).toEqual({ count: 1 });
        expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
        expect((await loadCronJobsStoreWithConfigJobs(storePath)).invalidConfigRows).toEqual([]);
      });
    },
  );

  it("allows Doctor to persist config repair while the retired row remains on disk", async () => {
    await withOpenClawTestState(
      { label: "retired-workshop-doctor", env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" } },
      async (state) => {
        await state.writeConfig({
          meta: { lastTouchedAt: "2026-09-01T00:00:00.000Z" },
          gateway: { mode: "local" },
          agents: { list: [{ id: "main", default: true }] },
        });
        const storePath = state.statePath("cron", "jobs.json");
        await saveCronJobsStore(storePath, { version: 1, jobs: [job("retired")] });
        const db = openOpenClawStateDatabase().db;
        db.prepare("UPDATE cron_jobs SET payload_kind = ?, job_json = ? WHERE job_id = ?").run(
          "skillCollectionReview",
          JSON.stringify(legacyReviewJob()),
          "retired",
        );

        await expect(
          prepareCronOwnerWriteRefusal({}, { storePath, env: state.env }),
        ).resolves.toHaveProperty("recheck");
        const result = await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          repairPrefixedConfig: true,
          invalidConfigNote: false,
        });

        expect(result.snapshot.valid).toBe(true);
        const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        expect(persisted.agents.entries).toHaveProperty("main");
        expect(persisted.agents).not.toHaveProperty("list");
        expect(
          db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get("retired"),
        ).toEqual({
          job_json: JSON.stringify(legacyReviewJob()),
        });
      },
    );
  });
});
