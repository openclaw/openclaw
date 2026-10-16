import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../test/helpers/cron/runtime-mutation.js";
import { createCronRegressionState } from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCronMutationCompletion } from "./mutation-completion.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "./scratch-contract.js";
import { readCronScratchSnapshot } from "./scratch-read.js";
import {
  deleteCronJobScratch,
  hashCronScratchSource,
  readCronJobScratchState,
} from "./scratch-store.js";
import { writeCronJobScratchForMaintenance } from "./scratch-write.kernel.js";
import { CronService } from "./service.js";
import * as runtimeMutation from "./service/runtime-mutation.js";
import * as cronStore from "./store.js";
import { loadCronJobsStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { replaceCronRows, upsertCronJobRow } from "./store/row-codec.js";
import { getCronStoreKysely } from "./store/schema.js";
import type { CronJob } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function withScratchService(
  run: (params: {
    service: CronService;
    job: CronJob;
    storePath: string;
    databasePath: string;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cron-scratch-worker" }, async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const state = createCronRegressionState({
      storePath,
      defaultAgentId: "alpha",
      nowMs: () => 1_000,
      runIsolatedAgentJob: async () => ({ status: "skipped" }),
    });
    const service = new CronService(state.deps);
    try {
      const added = await service.add({
        id: "scratch-owner",
        name: "scratch owner",
        agentId: "alpha",
        enabled: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "synthetic event" },
      });
      const job = "job" in added ? added.job : added;
      await service.readJob(job.id);
      await run({
        service,
        job,
        storePath,
        databasePath: resolveOpenClawStateSqlitePath(fixture.env),
      });
    } finally {
      service.stop();
    }
  });
}

describe("cron scratch worker service", () => {
  it("initializes missing shared state for a heartbeat scratch read off the caller thread", async () => {
    await withOpenClawTestState({ label: "heartbeat-scratch-cold-read" }, async (fixture) => {
      const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
      await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      const sql = observeMainThreadSql();
      let observed: Awaited<ReturnType<typeof readCronScratchSnapshot>>;
      let callerSql = 0;
      try {
        sql.calibrate();
        observed = await readCronScratchSnapshot(
          fixture.statePath("cron", "jobs.json"),
          { kind: "heartbeat", agentId: "alpha" },
          {
            path: databasePath,
            env: fixture.env,
          },
        );
        callerSql = sql.count();
      } finally {
        sql.restore();
      }
      expect(observed).toBeUndefined();
      expect((await fs.stat(databasePath)).isFile()).toBe(true);
      const verification = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          verification
            .prepare(
              "SELECT (SELECT COUNT(*) FROM cron_jobs) AS jobs, (SELECT COUNT(*) FROM cron_job_scratch) AS scratch",
            )
            .get(),
        ).toEqual({ jobs: 0, scratch: 0 });
      } finally {
        verification.close();
      }
      expect(callerSql).toBe(0);
    });
  });

  it("reads a legacy creation fallback without ignoring a persisted definition change", async () => {
    await withScratchService(async ({ service, job, storePath, databasePath }) => {
      await service.writeScratch(job.id, {
        content: "legacy private content",
        expectedRevision: 0,
      });
      const peer = new DatabaseSync(databasePath);
      const reader = new CronService(
        createCronRegressionState({
          storePath,
          defaultAgentId: "alpha",
          runIsolatedAgentJob: async () => ({ status: "skipped" }),
        }).deps,
      );
      try {
        const row = executeSqliteQuerySync(
          peer,
          getCronStoreKysely(peer)
            .selectFrom("cron_jobs")
            .select("job_json")
            .where("store_key", "=", cronStoreKey(storePath))
            .where("job_id", "=", job.id),
        ).rows[0];
        const { createdAtMs: _createdAtMs, ...legacy } = expectDefined(
          safeParseJsonRecord(expectDefined(row, "stored scratch job").job_json),
          "stored scratch job definition",
        );
        const writeDefinition = (definition: unknown) =>
          executeSqliteQuerySync(
            peer,
            getCronStoreKysely(peer)
              .updateTable("cron_jobs")
              .set({ job_json: JSON.stringify(definition) })
              .where("store_key", "=", cronStoreKey(storePath))
              .where("job_id", "=", job.id),
          );
        writeDefinition(legacy);
        const loadStore = cronStore.loadCronJobsStoreWithConfigJobs;
        const load = vi
          .spyOn(cronStore, "loadCronJobsStoreWithConfigJobs")
          .mockImplementationOnce(async (requestedPath) => {
            const loaded = await loadStore(requestedPath);
            // Only pin the clock-derived display fallback; persisted config and worker reads stay real.
            expectDefined(loaded.store.jobs[0], "loaded legacy row").createdAtMs = 1_000;
            return loaded;
          });
        let loaded: CronJob;
        try {
          loaded = expectDefined(await reader.readJob(job.id), "loaded legacy scratch job");
          expect(loaded.createdAtMs).toBe(1_000);
        } finally {
          load.mockRestore();
        }
        expect(await reader.readScratch(job.id)).toMatchObject({
          currentRevision: 1,
          scratch: { content: "legacy private content" },
        });
        expect(
          await reader.writeScratch(job.id, {
            content: "updated legacy private content",
            expectedRevision: 1,
          }),
        ).toMatchObject({ ok: true, currentRevision: 2 });
        writeDefinition({ ...legacy, createdAtMs: loaded.createdAtMs + 1_000 });
        await expect(reader.readScratch(job.id)).rejects.toThrow("changed after it was read");
      } finally {
        reader.stop();
        peer.close();
      }
    });
  });

  it("writes off the caller thread while preserving CAS, tombstones, and actual-write receipts", async () => {
    await withScratchService(async ({ service, job }) => {
      const steps = [
        {
          content: null,
          expectedRevision: 0,
          expected: { ok: true, currentRevision: 0 },
          committed: false,
        },
        {
          content: "scheduled café",
          expectedRevision: 0,
          expected: { ok: true, currentRevision: 1, scratch: { content: "scheduled café" } },
          committed: true,
        },
        {
          content: null,
          expectedRevision: 1,
          expected: { ok: true, currentRevision: 2 },
          committed: true,
        },
        {
          content: "stale resurrection",
          expectedRevision: 1,
          expected: { ok: false, reason: "revision-conflict", currentRevision: 2 },
          committed: false,
        },
      ];
      const sql = observeMainThreadSql();
      try {
        sql.calibrate();
        for (const step of steps) {
          sql.clear();
          const completion = expectDefined(
            createCronMutationCompletion("cron.scratch.set"),
            "scratch receipt",
          );
          const result = await completion.run(() =>
            service.writeScratch(job.id, {
              content: step.content,
              expectedRevision: step.expectedRevision,
              commitGuard: () => expect(service.getJob(job.id)?.agentId).toBe("alpha"),
            }),
          );
          expect(result).toMatchObject(step.expected);
          if (step.expected.currentRevision === 1) {
            expect(await service.readScratch(job.id)).toMatchObject({
              currentRevision: 1,
              scratch: { content: "scheduled café", revision: 1 },
            });
          }
          expect(completion.isCommitted()).toBe(step.committed);
          expect.soft(sql.count(), `scratch revision ${step.expected.currentRevision}`).toBe(0);
        }
      } finally {
        sql.restore();
      }
      expect(await service.readScratch(job.id)).toEqual({ currentRevision: 2 });
    });
  });

  it.each([
    { change: "caller revocation", boundary: "queued before dispatch" },
    { change: "job owner replacement", boundary: "queued before admission" },
  ] as const)("refuses scratch after $change ($boundary)", async ({ change }) => {
    await withScratchService(async ({ service, job, storePath, databasePath }) => {
      await service.writeScratch(job.id, { content: "retained", expectedRevision: 0 });
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
      const completion = expectDefined(
        createCronMutationCompletion("cron.scratch.set"),
        "scratch receipt",
      );
      const pending = completion
        .run(() =>
          service.writeScratch(job.id, {
            content: "must not commit",
            expectedRevision: 1,
            commitGuard: () => {
              if (!callerCurrent) {
                throw new Error("scratch caller revoked");
              }
              expect(service.getJob(job.id)?.agentId).toBe("alpha");
            },
          }),
        )
        .then(
          (value) => ({ kind: "returned" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
      try {
        expect(
          await Promise.race([
            entered.promise.then(() => "queued-before-admission"),
            pending.then(() => "completed-before-worker-admission"),
          ]),
        ).toBe("queued-before-admission");
        if (change === "caller revocation") {
          callerCurrent = false;
        } else {
          const peer = new DatabaseSync(databasePath);
          try {
            runSqliteImmediateTransactionSync(peer, () => {
              upsertCronJobRow(peer, cronStoreKey(storePath), { ...job, agentId: "beta" }, 0);
            });
          } finally {
            peer.close();
          }
          expect(
            (await loadCronJobsStore(storePath)).jobs.find((entry) => entry.id === job.id)?.agentId,
          ).toBe("beta");
        }
        release.resolve();
        const result = await pending;
        expect(result).toMatchObject({
          kind: "rejected",
          error: {
            message: expect.stringContaining(
              change === "caller revocation"
                ? "scratch caller revoked"
                : "changed after it was read",
            ),
          },
        });
        expect(completion.isCommitted()).toBe(false);
        expect(readCronJobScratchState(storePath, job.id)).toMatchObject({
          currentRevision: 1,
          scratch: { content: "retained" },
        });
      } finally {
        release.resolve();
        await pending;
        held.mockRestore();
      }
    });
  });

  it("retains scratch bytes without claiming completion after reply loss", async () => {
    await withScratchService(async ({ service, job, storePath }) => {
      const completion = expectDefined(
        createCronMutationCompletion("cron.scratch.set"),
        "scratch receipt",
      );
      const dropped = loseFirstCronMutationReply("cron.writeScratch");
      try {
        const result = await completion
          .run(() =>
            service.writeScratch(job.id, {
              content: "committed once",
              expectedRevision: 0,
            }),
          )
          .then(
            () => "reported",
            () => "reply-lost",
          );
        expect(result).toBe("reply-lost");
        expect(dropped.wasDropped()).toBe(true);
        expect(dropped.attempts).toEqual(["cron.writeScratch"]);
        await dropped.waitForExit();
        expect(completion.isCommitted()).toBe(false);
        expect(readCronJobScratchState(storePath, job.id)).toMatchObject({
          currentRevision: 1,
          scratch: { content: "committed once", revision: 1 },
        });
      } finally {
        await dropped.close();
      }
    });
  });
});

async function createFixture(jobIds = ["job-1"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-scratch-"));
  tempDirs.push(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const fixture = {
    storePath: path.join(root, "cron", "jobs.json"),
    options: { env },
  };
  const job: CronJob = {
    id: "job-1",
    name: "scratch-owner",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    state: {},
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    for (const [index, id] of jobIds.entries()) {
      upsertCronJobRow(db, cronStoreKey(fixture.storePath), { ...job, id }, index);
    }
  }, fixture.options);
  return {
    ...fixture,
    write: (
      content: string | null,
      input: Partial<
        Pick<
          Parameters<typeof writeCronJobScratchForMaintenance>[0],
          "jobId" | "storePath" | "expectedRevision" | "nowMs" | "sourceSha256"
        >
      > = {},
    ) => writeCronJobScratchForMaintenance({ ...fixture, jobId: "job-1", content, ...input }),
    read: (jobId = "job-1", storePath = fixture.storePath) =>
      readCronJobScratchState(storePath, jobId, fixture.options),
    remove: (expectedRevision: number) =>
      deleteCronJobScratch(fixture.storePath, "job-1", fixture.options, { expectedRevision }),
  };
}

describe("cron job scratch store", () => {
  it("keeps write guards scoped to the current job and store on a reused connection", async () => {
    const fixture = await createFixture(["job-1", "job-2"]);
    fixture.write("first");
    fixture.write("second");
    expect(fixture.write("other", { jobId: "job-2", expectedRevision: 0 })).toMatchObject({
      ok: true,
      currentRevision: 1,
    });
    expect(fixture.write("stale", { expectedRevision: 1 })).toEqual({
      ok: false,
      reason: "revision-conflict",
      currentRevision: 2,
    });
    const storePath = path.join(path.dirname(fixture.storePath), "other.json");
    expect(fixture.write("orphan", { storePath, expectedRevision: 0 })).toEqual({
      ok: false,
      reason: "revision-conflict",
      currentRevision: 0,
    });
    expect(fixture.read("job-1", storePath)).toEqual({ currentRevision: 0 });
    expect(fixture.read().scratch?.content).toBe("second");
  });

  it("marks actual writes but not an unset no-op or revision conflict", async () => {
    const fixture = await createFixture();
    for (const [content, expectedRevision, expected, committed] of [
      [null, undefined, { ok: true, currentRevision: 0 }, false],
      [
        "committed",
        undefined,
        {
          ok: true,
          currentRevision: 1,
          scratch: { content: "committed", revision: 1, updatedAtMs: 10 },
        },
        true,
      ],
      ["stale", 0, { ok: false, reason: "revision-conflict", currentRevision: 1 }, false],
    ] as const) {
      const completion = createCronMutationCompletion("cron.scratch.set")!;
      expect(
        await completion.run(async () => fixture.write(content, { expectedRevision, nowMs: 10 })),
      ).toEqual(expected);
      expect(completion.isCommitted()).toBe(committed);
    }
  });

  it("distinguishes empty content, CAS conflicts, tombstones, and guarded removal", async () => {
    const fixture = await createFixture();
    expect(fixture.read()).toEqual({ currentRevision: 0 });
    for (const [content, expectedRevision, nowMs, expected] of [
      [
        "",
        undefined,
        10,
        { ok: true, currentRevision: 1, scratch: { content: "", revision: 1, updatedAtMs: 10 } },
      ],
      ["stale", 0, 20, { ok: false, reason: "revision-conflict", currentRevision: 1 }],
      [
        "second",
        1,
        30,
        {
          ok: true,
          currentRevision: 2,
          scratch: { content: "second", revision: 2, updatedAtMs: 30 },
        },
      ],
      [null, 2, 40, { ok: true, currentRevision: 3 }],
      ["resurrected", 2, 50, { ok: false, reason: "revision-conflict", currentRevision: 3 }],
      [
        "recreated",
        3,
        60,
        {
          ok: true,
          currentRevision: 4,
          scratch: { content: "recreated", revision: 4, updatedAtMs: 60 },
        },
      ],
    ] as const) {
      expect(fixture.write(content, { expectedRevision, nowMs })).toEqual(expected);
      if (expected.ok) {
        const { ok: _ok, ...snapshot } = expected;
        expect(fixture.read()).toEqual(snapshot);
      }
    }
    expect(fixture.remove(3)).toBe(false);
    expect(fixture.read().currentRevision).toBe(4);
    expect(fixture.remove(4)).toBe(true);
    expect(fixture.read()).toEqual({ currentRevision: 0 });
    expect(fixture.remove(0)).toBe(true);
  });

  it("rejects a late write after the owning job is durably deleted", async () => {
    const fixture = await createFixture();
    runOpenClawStateWriteTransaction(
      ({ db }) => replaceCronRows(db, cronStoreKey(fixture.storePath), { version: 1, jobs: [] }),
      fixture.options,
    );
    expect(fixture.write("orphaned heartbeat scratch", { expectedRevision: 0, nowMs: 10 })).toEqual(
      { ok: false, reason: "revision-conflict", currentRevision: 0 },
    );
    expect(fixture.read()).toEqual({ currentRevision: 0 });
  });

  it.each(["retained content", null])(
    "preserves the revision of orphan scratch when rejecting a write (%s)",
    async (content) => {
      const fixture = await createFixture();
      fixture.write("initial");
      fixture.write(content);
      const previous = fixture.read();
      // Job removal commits before scratch cleanup, so a late writer can see this state.
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          executeSqliteQuerySync(
            db,
            getCronStoreKysely(db)
              .deleteFrom("cron_jobs")
              .where("store_key", "=", cronStoreKey(fixture.storePath))
              .where("job_id", "=", "job-1"),
          ),
        fixture.options,
      );
      expect(fixture.write("late write", { expectedRevision: previous.currentRevision })).toEqual({
        ok: false,
        reason: "revision-conflict",
        currentRevision: 2,
      });
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
