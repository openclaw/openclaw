import fs from "node:fs/promises";
import { StatementSync } from "node:sqlite";
import { expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { collectLegacyCronStoreHealthFindings } from "../commands/doctor/cron/index.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { resolveCronJobsStorePath, saveCronQuarantinedJobs } from "./store.js";
import { withCronStore } from "./store.worker.test-support.js";
import type { CronStoreFile } from "./types.js";

it.each([false, true])(
  "reports persisted quarantine through Doctor without caller-thread queries (cold=%s)",
  async (cold) => {
    await withCronStore("cron-quarantine-doctor", async (state) => {
      await saveCronQuarantinedJobs({
        storePath: resolveCronJobsStorePath(),
        entries: [{ sourceIndex: 0, reason: "missing-schedule", job: { id: "quarantined-job" } }],
        nowMs: 123,
      });
      if (cold) {
        await state.close();
      }
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        const findings = await collectLegacyCronStoreHealthFindings({ cfg: {} });
        expect(
          findings.find((finding) => finding.requirement === "quarantined-cron-rows"),
        ).toMatchObject({ message: expect.stringContaining("1 quarantined cron job row") });
        expect(observation.queries.some((sql) => sql.includes('"diagnostic_events"'))).toBe(false);
      } finally {
        observation.restore();
      }
    });
  },
);

it.each([false, true])(
  "loads cold readonly cron state off the host with artifact preservation=%s",
  async (preserveArtifacts) => {
    await withCronStore("cron-readonly-worker", async (state) => {
      const job = makeCronJob({
        name: "scheduled café 🦞",
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "persisted event" },
        state: { nextRunAtMs: 60_001 },
      });
      const store: CronStoreFile = { version: 1, jobs: [job] };
      await state.save(store);
      await state.close();
      const before = await state.bytes();
      const sql = observeMainThreadSql({ includeClose: true });
      try {
        const loaded = await state.read(preserveArtifacts);
        expect(loaded.store).toEqual(store);
        sql.expectIdle();
        expect(await state.bytes()).toEqual(before);
      } finally {
        sql.restore();
      }
    });
  },
);

it("leaves missing databases absent and legacy layouts unmigrated", async () => {
  await withCronStore("cron-readonly-legacy", async (state) => {
    const databasePath = state.databasePath;
    const empty = await state.read();
    expect(empty.store).toEqual({ version: 1, jobs: [] });
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await state.createDatabase("CREATE TABLE legacy_marker(value TEXT); PRAGMA user_version = 1;");
    const before = await state.bytes();
    for (const preserve of [true, false]) {
      expect(await state.read(preserve)).toEqual(empty);
      expect(await state.bytes()).toEqual(before);
    }
  });
});

it("preserves native diagnostic errors without repairing an incompatible cron table", async () => {
  await withCronStore("cron-readonly-diagnostic", async (state) => {
    await state.createDatabase("CREATE TABLE cron_jobs(legacy_column TEXT)");
    const before = await state.bytes();
    await expect(state.read()).rejects.toMatchObject({
      code: "ERR_SQLITE_ERROR",
      message: expect.stringContaining("no such column"),
    });
    expect(await state.bytes()).toEqual(before);
  });
});
