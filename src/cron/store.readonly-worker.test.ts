import fs from "node:fs/promises";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { isProcessAlive, waitForFixtureFile } from "../../test/helpers/process-wait.js";
import { withinTest } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { collectLegacyCronStoreHealthFindings } from "../commands/doctor/cron/index.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { getTrackedWorkerLifecycleSnapshot } from "../infra/worker-cpu.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { resolveCronJobsStorePath, saveCronQuarantinedJobs } from "./store.js";
import { withCronStore } from "./store.worker.test-support.js";
import { inspectCronJobsReadOnly } from "./store/read-only.js";
import type { CronStoreFile } from "./types.js";

it("cancels Doctor cron inventory during copying without an orphan child or snapshot", async ({
  signal,
}) => {
  await withCronStore("cron-readonly-cancellation", async (state) => {
    await state.save({ version: 1, jobs: [makeCronJob({})] });
    await state.close();
    const original = await state.bytes();
    const ready = state.statePath("cron-copy-ready.json");
    const preload = state.statePath("hold-cron-copy.mjs");
    await fs.writeFile(
      preload,
      `import fs from "node:fs";
const open = fs.openSync;
fs.openSync = (pathname, ...args) => {
  const descriptor = open(pathname, ...args);
  if (String(pathname).endsWith("database.sqlite.partial") &&
      process.argv.includes(${JSON.stringify(SQLITE_READONLY_CHILD_ARG)})) {
    fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, partial: String(pathname) }));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return descriptor;
};`,
    );
    const previousNodeOptions = process.env.NODE_OPTIONS;
    vi.stubEnv(
      "NODE_OPTIONS",
      [previousNodeOptions, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(" "),
    );
    const cancellation = new AbortController();
    const inspection = withSqliteReadOnlyWorkerScope(() => inspectCronJobsReadOnly(state.env), {
      signal: cancellation.signal,
      deadlineOwnedByCaller: true,
    });
    const settled = inspection.then(
      () => undefined,
      () => undefined,
    );
    let childPid: number | undefined;
    try {
      await withinTest(waitForFixtureFile(ready, settled), signal);
      const receipt: unknown = JSON.parse(await fs.readFile(ready, "utf8"));
      if (
        typeof receipt !== "object" ||
        receipt === null ||
        !("pid" in receipt) ||
        typeof receipt.pid !== "number" ||
        !("partial" in receipt) ||
        typeof receipt.partial !== "string"
      ) {
        throw new Error("Cron copy fixture did not publish its child and partial image.");
      }
      childPid = receipt.pid;
      await expect(fs.stat(receipt.partial)).resolves.toBeDefined();
      cancellation.abort(new Error("Doctor cron inspection cancelled"));
      await expect(withinTest(inspection, signal)).rejects.toThrow(
        "Doctor cron inspection cancelled",
      );
      expect(isProcessAlive(childPid)).toBe(false);
      await expect(fs.stat(path.dirname(receipt.partial))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await state.bytes()).toEqual(original);
    } finally {
      cancellation.abort();
      if (childPid !== undefined && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      await settled;
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
    }
  });
});

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

it("keeps legacy reads immutable across reader reuse, idle expiry and canonical close", () =>
  withCronStore("cron-readonly-legacy", async (state) => {
    const empty = await state.read();
    expect(empty.store).toEqual({ version: 1, jobs: [] });
    await expect(fs.stat(state.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await state.createDatabase("CREATE TABLE legacy_marker(value TEXT); PRAGMA user_version = 1;");
    const before = await state.bytes();
    expect(await state.read(true)).toEqual(empty);
    const starts = () =>
      getTrackedWorkerLifecycleSnapshot()
        .workerLifecycle.filter(({ script }) => script.includes("read-only.worker"))
        .reduce((total, worker) => total + worker.started, 0);
    const initial = starts();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (const [index, idle] of [0, 120_001, 300_001, undefined].entries()) {
        await (idle === undefined ? state.close() : vi.advanceTimersByTimeAsync(idle));
        for (let read = 0; read < 3; read++) {
          expect(await state.read()).toEqual(empty);
        }
        expect(starts() - initial).toBe(index + 1);
        expect(await state.bytes()).toEqual(before);
      }
    } finally {
      vi.useRealTimers();
    }
  }));

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
