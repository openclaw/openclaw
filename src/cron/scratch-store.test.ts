import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../test/helpers/cron/runtime-mutation.js";
import {
  deleteCronJobScratch,
  writeCronJobScratchForMaintenance,
} from "../../test/helpers/cron/scratch-store.js";
import { createCronRegressionState } from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { writeConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { prepareCronAutomationPrompt } from "./isolated-agent/run-automation-context.js";
import { createCronMutationCompletion } from "./mutation-completion.js";
import { CRON_JOB_SCRATCH_MAX_BYTES, type CronScratchReadCommand } from "./scratch-contract.js";
import { readCronScratchSnapshot } from "./scratch-read.js";
import { readCronScratchSnapshotInDatabase } from "./scratch-read.kernel.js";
import { hashCronScratchSource, readCronJobScratchState } from "./scratch-store.js";
import { cronTestJob } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import * as runtimeMutation from "./service/runtime-mutation.js";
import * as cronStore from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { replaceCronRows, upsertCronJobRow } from "./store/row-codec.js";
import type { CronJob } from "./types.js";

const testStates: Awaited<ReturnType<typeof createOpenClawTestState>>[] = [];
const services: CronService[] = [];
const scratchReceipt = () =>
  expectDefined(createCronMutationCompletion("cron.scratch.set"), "scratch receipt");
const settle = <T>(pending: Promise<T>) =>
  pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
const conflict = (currentRevision: number) => ({
  ok: false,
  reason: "revision-conflict",
  currentRevision,
});
const scratchState = (content: string | null, revision: number, updatedAtMs?: number) => ({
  currentRevision: revision,
  ...(content !== null
    ? { scratch: { content, revision, ...(updatedAtMs === undefined ? {} : { updatedAtMs }) } }
    : {}),
});
const written = (...input: Parameters<typeof scratchState>) => ({
  ok: true,
  ...scratchState(...input),
});
const createService = (storePath: string, nowMs = () => Date.now()) =>
  new CronService(
    createCronRegressionState({
      storePath,
      defaultAgentId: "alpha",
      runIsolatedAgentJob: async () => ({ status: "skipped" }),
      nowMs,
    }).deps,
  );

async function withoutCallerSql<T>(run: () => Promise<T>) {
  const sql = observeMainThreadSql();
  using _ = { [Symbol.dispose]: () => sql.restore() };
  sql.calibrate();
  const result = await run();
  expect(sql.count()).toBe(0);
  return result;
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.stop();
  }
  closeOpenClawStateDatabaseForTest();
  await Promise.all(testStates.splice(0).map((state) => state.cleanup()));
});

async function createWorkerFixture() {
  const fixture = await createFixture(["scratch-owner"], true);
  const { job, storePath } = fixture;
  const service = createService(storePath, () => 1_000);
  services.push(service);
  await service.readJob(job.id);
  return {
    ...fixture,
    service,
    read: () => service.readScratch(job.id),
    write: (content: string | null, expectedRevision?: number, commitGuard?: () => void) =>
      service.writeScratch(job.id, { content, expectedRevision, commitGuard }),
    stored: fixture.read,
  };
}

describe("cron scratch worker service", () => {
  it("prepares fresh scratch from the selected cron partition without caller SQL", async () => {
    const { write, job, storePath } = await createWorkerFixture();
    await write("first scratch", 0);
    await writeConfigMachineStateAsync("cron.store", `${storePath}.other`);
    const params = {
      cfg: {},
      job,
      agentId: "alpha",
      runSessionKey: "agent:alpha:cron:scratch-owner",
      message: "synthetic prompt",
      storePath: `${storePath}.sessions`,
      cronStorePath: storePath,
      assertCurrent: () => {},
      baseSessionKey: "agent:alpha:main",
      formattedTime: "2026-10-22",
      timeLine: "Current time: 2026-10-22",
    };
    const first = await withoutCallerSql(() => prepareCronAutomationPrompt(params));
    expect(first.commandBody).toContain("Automation scratch (revision 1):\nfirst scratch");
    await write("updated scratch", 1);
    const updated = await withoutCallerSql(() => prepareCronAutomationPrompt(params));
    expect(updated.commandBody).toContain("Automation scratch (revision 2):\nupdated scratch");

    // Standalone callers select the current machine partition through the worker too.
    const { cronStorePath: _, ...standalone } = params;
    const prepareStandalone = () => withoutCallerSql(() => prepareCronAutomationPrompt(standalone));
    expect((await prepareStandalone()).commandBody).not.toContain("Automation scratch");
    await writeConfigMachineStateAsync("cron.store", storePath);
    expect((await prepareStandalone()).commandBody).toContain("updated scratch");
  });

  it("initializes missing shared state for a heartbeat scratch read off the caller thread", async () => {
    await withOpenClawTestState({ label: "heartbeat-scratch-cold-read" }, async (fixture) => {
      const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
      await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      const observed = await withoutCallerSql(() =>
        readCronScratchSnapshot(
          fixture.statePath("cron", "jobs.json"),
          { kind: "heartbeat", agentId: "alpha" },
          { path: databasePath, env: fixture.env },
        ),
      );
      expect(observed).toBeUndefined();
      expect((await fs.stat(databasePath)).isFile()).toBe(true);
      using verification = new DatabaseSync(databasePath, { readOnly: true });
      const counts = verification
        .prepare(
          "SELECT (SELECT COUNT(*) FROM cron_jobs) AS jobs, (SELECT COUNT(*) FROM cron_job_scratch) AS scratch",
        )
        .get();
      expect(counts).toEqual({ jobs: 0, scratch: 0 });
    });
  });

  it("reads a legacy creation fallback without ignoring a persisted definition change", async () => {
    const { write, job, storePath, databasePath } = await createWorkerFixture();
    await write("legacy private content", 0);
    const reader = createService(storePath);
    const read = () => reader.readScratch(job.id);
    using peer = new DatabaseSync(databasePath);
    using _ = { [Symbol.dispose]: () => reader.stop() };
    const key = cronStoreKey(storePath);
    // Direct fixture corruption models a legacy row without invoking the writer's normalization.
    peer
      .prepare(
        "UPDATE cron_jobs SET job_json = json_remove(job_json, '$.createdAtMs') WHERE store_key = ? AND job_id = ?",
      )
      .run(key, job.id);
    const loadStore = cronStore.loadCronJobsStoreWithConfigJobs;
    let loaded: CronJob;
    {
      using load = vi
        .spyOn(cronStore, "loadCronJobsStoreWithConfigJobs")
        .mockImplementationOnce(async (requestedPath) => {
          const store = await loadStore(requestedPath);
          // Only pin the clock-derived display fallback; persisted config and worker reads stay real.
          expectDefined(store.store.jobs[0], "loaded legacy row").createdAtMs = 1_000;
          return store;
        });
      void load;
      loaded = expectDefined(await reader.readJob(job.id), "loaded legacy scratch job");
    }
    expect(await read()).toMatchObject(scratchState("legacy private content", 1));
    expect(
      await reader.writeScratch(job.id, {
        content: "updated legacy private content",
        expectedRevision: 1,
      }),
    ).toMatchObject({
      ok: true,
      currentRevision: 2,
    });
    peer
      .prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.createdAtMs', ?) WHERE store_key = ? AND job_id = ?",
      )
      .run(loaded.createdAtMs + 1_000, key, job.id);
    await expect(read()).rejects.toThrow("changed after it was read");
  });

  it("writes off the caller thread while preserving CAS, tombstones, and actual-write receipts", async () => {
    const { service, job, write, read } = await createWorkerFixture();
    expect(await read()).toEqual({ currentRevision: 0 });
    for (const [content, expectedRevision, expected, committed] of [
      [null, undefined, written(null, 0), false],
      ["", undefined, written("", 1, 1_000), true],
      ["stale", 0, conflict(1), false],
      ["scheduled café", 1, written("scheduled café", 2, 1_000), true],
      [null, 2, written(null, 3), true],
      ["stale resurrection", 2, conflict(3), false],
      ["recreated", 3, written("recreated", 4, 1_000), true],
    ] as const) {
      const completion = scratchReceipt();
      await withoutCallerSql(async () => {
        const result = await completion.run(() =>
          write(content, expectedRevision, () =>
            expect(service.getJob(job.id)?.agentId).toBe("alpha"),
          ),
        );
        expect(result).toEqual(expected);
        if (expected.ok) {
          const { ok: _, ...snapshot } = expected;
          expect(await read()).toEqual(snapshot);
        }
        expect(completion.isCommitted()).toBe(committed);
      });
    }
  });

  it.each([
    { change: "caller revocation", boundary: "queued before dispatch" },
    { change: "job owner replacement", boundary: "queued before admission" },
  ] as const)("refuses scratch after $change ($boundary)", async ({ change }) => {
    const { service, job, storePath, databasePath, write, stored } = await createWorkerFixture();
    await write("retained", 0);
    const entered = createDeferred();
    const release = createDeferred();
    const execute = runtimeMutation.runCronRuntimeMutation;
    const held = vi
      .spyOn(runtimeMutation, "runCronRuntimeMutation")
      .mockImplementationOnce(async (params) => {
        entered.resolve();
        await release.promise;
        return execute(params);
      });
    let callerCurrent = true;
    const completion = scratchReceipt();
    const pending = settle(
      completion.run(() =>
        write("must not commit", 1, () => {
          if (!callerCurrent) {
            throw new Error("scratch caller revoked");
          }
          expect(service.getJob(job.id)?.agentId).toBe("alpha");
        }),
      ),
    );
    try {
      expect(
        await Promise.race([entered.promise.then(() => true), pending.then(() => false)]),
      ).toBe(true);
      if (change === "caller revocation") {
        callerCurrent = false;
      } else {
        using peer = new DatabaseSync(databasePath);
        runSqliteImmediateTransactionSync(peer, () => {
          upsertCronJobRow(peer, cronStoreKey(storePath), { ...job, agentId: "beta" }, 0);
        });
      }
      release.resolve();
      const message =
        change === "caller revocation" ? "scratch caller revoked" : "changed after it was read";
      expect(await pending).toHaveProperty("error.message", expect.stringContaining(message));
      expect(completion.isCommitted()).toBe(false);
      expect(stored()).toMatchObject(scratchState("retained", 1));
    } finally {
      release.resolve();
      await pending;
      held.mockRestore();
    }
  });

  it("retains scratch bytes without claiming completion after reply loss", async () => {
    const { write, stored } = await createWorkerFixture();
    const completion = scratchReceipt();
    const dropped = loseFirstCronMutationReply("cron.writeScratch");
    await using _ = { [Symbol.asyncDispose]: () => dropped.close() };
    expect(await settle(completion.run(() => write("committed once", 0)))).toHaveProperty("error");
    expect(dropped.wasDropped()).toBe(true);
    expect(dropped.attempts).toEqual(["cron.writeScratch"]);
    await dropped.waitForExit();
    expect(completion.isCommitted()).toBe(false);
    expect(stored()).toMatchObject(scratchState("committed once", 1));
  });
});

type MaintenanceWrite = Partial<
  Omit<Parameters<typeof writeCronJobScratchForMaintenance>[0], "content" | "options">
>;
async function createFixture(jobIds: [string, ...string[]] = ["job-1"], applyEnv = false) {
  const state = await createOpenClawTestState({ label: "cron-scratch", applyEnv });
  testStates.push(state);
  const fixture = {
    storePath: state.statePath("cron", "jobs.json"),
    options: { env: state.env },
  };
  const job = cronTestJob({
    id: jobIds[0],
    agentId: "alpha",
    enabled: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "test" },
  });
  runOpenClawStateWriteTransaction(({ db }) => {
    for (const [index, id] of jobIds.entries()) {
      upsertCronJobRow(db, cronStoreKey(fixture.storePath), { ...job, id }, index);
    }
  }, fixture.options);
  return {
    ...fixture,
    job,
    databasePath: resolveOpenClawStateSqlitePath(state.env),
    write: (content: string | null, input: MaintenanceWrite = {}) =>
      writeCronJobScratchForMaintenance({ ...fixture, jobId: job.id, content, ...input }),
    read: (jobId = job.id, storePath = fixture.storePath) =>
      readCronJobScratchState(storePath, jobId, fixture.options),
    remove: (expectedRevision: number) =>
      deleteCronJobScratch(fixture.storePath, job.id, fixture.options, { expectedRevision }),
  };
}

describe("cron job scratch store", () => {
  it("reads current job and missing-heartbeat scratch once without read transactions", async () => {
    const { requireNativeSqliteDatabase } = await import("../test-utils/native-sqlite.js");
    const fixture = await createFixture();
    const db = requireNativeSqliteDatabase(openOpenClawStateDatabase(fixture.options).db);
    const tracker = trackSqliteStatementExecutions(db, ["reads"], (sql) =>
      /^\s*select\b/i.test(sql) && /\b(?:cron_jobs|cron_job_scratch)\b/i.test(sql) ? "reads" : null,
    );
    const exec = vi.spyOn(db, "exec");
    using _ = {
      [Symbol.dispose]: () => {
        tracker.restore();
        exec.mockRestore();
      },
    };
    const read = (selector: CronScratchReadCommand["selector"]) => {
      const beforeReads = tracker.counts.reads;
      const beforeExec = exec.mock.calls.length;
      const snapshot = readCronScratchSnapshotInDatabase(db, {
        type: "cron.scratch",
        storeKey: cronStoreKey(fixture.storePath),
        selector,
      });
      expect.soft(tracker.counts.reads - beforeReads).toBe(1);
      expect
        .soft(
          exec.mock.calls
            .slice(beforeExec)
            .filter(([sql]) => /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)),
        )
        .toEqual([]);
      return snapshot;
    };
    const readJob = () => {
      const snapshot = read({ kind: "job", jobId: "job-1", createdAtMsFallback: 1 });
      expect(snapshot).toMatchObject({ jobId: "job-1", configRevision: expect.any(String) });
      return snapshot?.state;
    };
    expect(readJob()).toEqual(scratchState(null, 0));
    fixture.write("current scratch", { expectedRevision: 0, nowMs: 10 });
    expect(readJob()).toEqual(scratchState("current scratch", 1, 10));
    fixture.write(null, { expectedRevision: 1, nowMs: 20 });
    expect(readJob()).toEqual(scratchState(null, 2));
    expect(read({ kind: "heartbeat", agentId: "missing-monitor" })).toBeUndefined();
  });

  it("keeps write guards scoped to the current job and store on a reused connection", async () => {
    const fixture = await createFixture(["job-1", "job-2"]);
    fixture.write("first");
    fixture.write("second");
    expect(fixture.write("other", { jobId: "job-2", expectedRevision: 0 })).toMatchObject(
      written("other", 1),
    );
    expect(fixture.write("stale", { expectedRevision: 1 })).toEqual(conflict(2));
    const storePath = path.join(path.dirname(fixture.storePath), "other.json");
    expect(fixture.write("orphan", { storePath, expectedRevision: 0 })).toEqual(conflict(0));
    expect(fixture.read("job-1", storePath)).toEqual({ currentRevision: 0 });
    expect(fixture.read().scratch?.content).toBe("second");
  });

  it.each([
    { contents: [] },
    { contents: ["initial", "retained content"] },
    { contents: ["initial", null] },
  ])(
    "rejects writes after job deletion, preserving any orphan revision ($contents)",
    async ({ contents }) => {
      const fixture = await createFixture();
      for (const content of contents) {
        fixture.write(content);
      }
      const previous = fixture.read();
      runOpenClawStateWriteTransaction(({ db }) => {
        const key = cronStoreKey(fixture.storePath);
        if (contents.length === 0) {
          replaceCronRows(db, key, { version: 1, jobs: [] });
          return;
        }
        // Model the gap after job removal but before scratch cleanup.
        db.prepare("DELETE FROM cron_jobs WHERE store_key = ? AND job_id = ?").run(key, "job-1");
      }, fixture.options);
      expect(fixture.write("late write", { expectedRevision: contents.length, nowMs: 10 })).toEqual(
        conflict(contents.length),
      );
      expect(fixture.read()).toEqual(previous);
    },
  );

  it.each(["write", "delete"] as const)(
    "preserves native timestamp range errors during %s",
    async (operation) => {
      const fixture = await createFixture();
      fixture.write("initial");
      fixture.write(null);
      const { db } = openOpenClawStateDatabase(fixture.options);
      const storeKey = cronStoreKey(fixture.storePath);
      // A valid SQLite integer can exceed the JavaScript driver's numeric range.
      db.prepare(
        "UPDATE cron_job_scratch SET updated_at_ms = ? WHERE store_key = ? AND job_id = ?",
      ).run(9007199254740995n, storeKey, "job-1");
      const stored = db.prepare(
        "SELECT * FROM cron_job_scratch WHERE store_key = ? AND job_id = ?",
      );
      stored.setReadBigInts(true);
      const before = stored.get(storeKey, "job-1");
      expect(() =>
        operation === "write" ? fixture.write("replacement") : fixture.remove(2),
      ).toThrow(/too large to be represented as a JavaScript number/);
      expect(stored.get(storeKey, "job-1")).toEqual(before);
    },
  );

  it("records migration provenance and clears it on plain rewrites", async () => {
    const fixture = await createFixture();
    const content = "# Monitor\n\nCheck mail.\n";
    const sourceSha256 = hashCronScratchSource(content);
    fixture.write(content, { sourceSha256, nowMs: 10 });
    expect(fixture.read().scratch).toEqual({ content, revision: 1, sourceSha256, updatedAtMs: 10 });
    fixture.write("rewritten", { nowMs: 20 });
    expect(fixture.read().scratch).toEqual({ content: "rewritten", revision: 2, updatedAtMs: 20 });
  });

  it("rejects content above the fixed UTF-8 byte limit", async () => {
    const fixture = await createFixture();
    expect(() => fixture.write("é".repeat(CRON_JOB_SCRATCH_MAX_BYTES / 2 + 1))).toThrow(
      `cron scratch exceeds ${CRON_JOB_SCRATCH_MAX_BYTES} bytes`,
    );
  });
});
