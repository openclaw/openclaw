import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../test/helpers/cron/runtime-mutation.js";
import { createCronRegressionState } from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
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
import { loadCronJobsStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { replaceCronRows, upsertCronJobRow } from "./store/row-codec.js";
import { tryParseJsonObject } from "./store/scalar-codec.js";
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

  it("reads scratch off the caller thread through the actual service", async () => {
    await withScratchService(async ({ service, job }) => {
      await service.writeScratch(job.id, { content: "private read content", expectedRevision: 0 });
      const sql = observeMainThreadSql();
      try {
        sql.calibrate();
        expect(await service.readScratch(job.id)).toMatchObject({
          currentRevision: 1,
          scratch: { content: "private read content", revision: 1 },
        });
        sql.expectIdle();
      } finally {
        sql.restore();
      }
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
          tryParseJsonObject(expectDefined(row, "stored scratch job").job_json),
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
        const loaded = expectDefined(await reader.readJob(job.id), "loaded legacy scratch job");
        await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(loaded.createdAtMs));
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
    { change: "caller revocation", boundary: "native commit admission" },
    { change: "job owner replacement", boundary: "queued before admission" },
  ] as const)("refuses scratch after $change ($boundary)", async ({ change }) => {
    await withScratchService(async ({ service, job, storePath, databasePath }) => {
      await service.writeScratch(job.id, { content: "retained", expectedRevision: 0 });
      const entered = createDeferred();
      const release = createDeferred();
      const execute = runtimeMutation.runCronRuntimeMutation;
      const held =
        change === "job owner replacement"
          ? vi
              .spyOn(runtimeMutation, "runCronRuntimeMutation")
              .mockImplementationOnce(async (params) => {
                entered.resolve();
                await release.promise;
                return execute(params);
              })
          : undefined;
      let callerCurrent = true;
      let commitAdmissionWitnessed = false;
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const admission =
        change === "caller revocation"
          ? vi
              .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
              .mockImplementation((admit, attachment) => {
                let nonce: string | undefined;
                return createAdmission((request, grant) => {
                  const facts = request.facts;
                  if (
                    request.stage === "transaction" &&
                    isRecord(facts) &&
                    typeof facts.nonce === "string"
                  ) {
                    nonce = facts.nonce;
                  }
                  if (
                    request.stage === "commit" &&
                    nonce &&
                    isRecord(facts) &&
                    facts.nonce === nonce &&
                    facts.bytes instanceof Uint8Array
                  ) {
                    commitAdmissionWitnessed = true;
                    callerCurrent = false;
                  }
                  admit(request, grant);
                }, attachment);
              })
          : undefined;
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
        if (change === "job owner replacement") {
          expect(
            await Promise.race([
              entered.promise.then(() => "queued-before-admission"),
              pending.then(() => "completed-before-worker-admission"),
            ]),
          ).toBe("queued-before-admission");
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
        if (change === "caller revocation") {
          expect(commitAdmissionWitnessed).toBe(true);
        }
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
        held?.mockRestore();
        admission?.mockRestore();
      }
    });
  });

  it("retains a committed scratch write when its worker reply is lost without replay", async () => {
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
        expect(completion.isCommitted()).toBe(true);
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
  return fixture;
}

describe("cron job scratch store", () => {
  it("keeps write guards scoped to the current job and store on a reused connection", async () => {
    const fixture = await createFixture(["job-1", "job-2"]);
    writeCronJobScratchForMaintenance({ ...fixture, jobId: "job-1", content: "first" });
    writeCronJobScratchForMaintenance({ ...fixture, jobId: "job-1", content: "second" });
    expect(
      writeCronJobScratchForMaintenance({
        ...fixture,
        jobId: "job-2",
        content: "other",
        expectedRevision: 0,
      }),
    ).toMatchObject({ ok: true, currentRevision: 1 });
    expect(
      writeCronJobScratchForMaintenance({
        ...fixture,
        jobId: "job-1",
        content: "stale",
        expectedRevision: 1,
      }),
    ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 2 });
    const otherStore = path.join(path.dirname(fixture.storePath), "other.json");
    expect(
      writeCronJobScratchForMaintenance({
        ...fixture,
        storePath: otherStore,
        jobId: "job-1",
        content: "orphan",
        expectedRevision: 0,
      }),
    ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 0 });
    expect(readCronJobScratchState(otherStore, "job-1", fixture.options)).toEqual({
      currentRevision: 0,
    });
    expect(
      readCronJobScratchState(fixture.storePath, "job-1", fixture.options).scratch?.content,
    ).toBe("second");
  });

  it("marks actual writes but not an unset no-op or revision conflict", async () => {
    const fixture = await createFixture();
    const absent = createCronMutationCompletion("cron.scratch.set")!;
    await expect(
      absent.run(async () =>
        writeCronJobScratchForMaintenance({
          ...fixture,
          jobId: "job-1",
          content: null,
        }),
      ),
    ).resolves.toEqual({ ok: true, currentRevision: 0 });
    expect(absent.isCommitted()).toBe(false);

    const write = createCronMutationCompletion("cron.scratch.set")!;
    await write.run(async () =>
      writeCronJobScratchForMaintenance({
        ...fixture,
        jobId: "job-1",
        content: "committed",
      }),
    );
    expect(write.isCommitted()).toBe(true);

    const conflict = createCronMutationCompletion("cron.scratch.set")!;
    await expect(
      conflict.run(async () =>
        writeCronJobScratchForMaintenance({
          ...fixture,
          jobId: "job-1",
          content: "stale",
          expectedRevision: 0,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: "revision-conflict" });
    expect(conflict.isCommitted()).toBe(false);
  });

  it("distinguishes no row from present-empty content", async () => {
    const fixture = await createFixture();
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options)).toEqual({
      currentRevision: 0,
    });

    const write = writeCronJobScratchForMaintenance({
      ...fixture,
      jobId: "job-1",
      content: "",
      nowMs: 10,
    });

    expect(write).toEqual({
      ok: true,
      currentRevision: 1,
      scratch: { content: "", revision: 1, updatedAtMs: 10 },
    });
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options)).toEqual({
      currentRevision: 1,
      scratch: { content: "", revision: 1, updatedAtMs: 10 },
    });
  });

  it("compare-and-swaps revisions and keeps a tombstone across unset", async () => {
    const fixture = await createFixture();
    writeCronJobScratchForMaintenance({ ...fixture, jobId: "job-1", content: "first", nowMs: 10 });

    expect(
      writeCronJobScratchForMaintenance({
        ...fixture,
        jobId: "job-1",
        content: "stale",
        expectedRevision: 0,
        nowMs: 20,
      }),
    ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 1 });

    expect(
      writeCronJobScratchForMaintenance({
        ...fixture,
        jobId: "job-1",
        content: "second",
        expectedRevision: 1,
        nowMs: 30,
      }),
    ).toEqual({
      ok: true,
      currentRevision: 2,
      scratch: { content: "second", revision: 2, updatedAtMs: 30 },
    });

    expect(
      writeCronJobScratchForMaintenance({
        ...fixture,
        jobId: "job-1",
        content: null,
        expectedRevision: 2,
        nowMs: 40,
      }),
    ).toEqual({ ok: true, currentRevision: 3 });
    // The tombstone keeps the revision lineage monotonic: a stale writer that
    // read revision 2 before the unset cannot resurrect old content later.
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options)).toEqual({
      currentRevision: 3,
    });
    expect(
      writeCronJobScratchForMaintenance({
        ...fixture,
        jobId: "job-1",
        content: "resurrected",
        expectedRevision: 2,
        nowMs: 50,
      }),
    ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 3 });
    expect(
      writeCronJobScratchForMaintenance({
        ...fixture,
        jobId: "job-1",
        content: "recreated",
        expectedRevision: 3,
        nowMs: 60,
      }),
    ).toEqual({
      ok: true,
      currentRevision: 4,
      scratch: { content: "recreated", revision: 4, updatedAtMs: 60 },
    });
    expect(
      deleteCronJobScratch(fixture.storePath, "job-1", fixture.options, { expectedRevision: 3 }),
    ).toBe(false);
    expect(
      readCronJobScratchState(fixture.storePath, "job-1", fixture.options).currentRevision,
    ).toBe(4);
    expect(
      deleteCronJobScratch(fixture.storePath, "job-1", fixture.options, { expectedRevision: 4 }),
    ).toBe(true);
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options)).toEqual({
      currentRevision: 0,
    });
    expect(
      deleteCronJobScratch(fixture.storePath, "job-1", fixture.options, { expectedRevision: 0 }),
    ).toBe(true);
  });

  it("rejects a late write after the owning job is durably deleted", async () => {
    const fixture = await createFixture();
    runOpenClawStateWriteTransaction(
      ({ db }) => replaceCronRows(db, cronStoreKey(fixture.storePath), { version: 1, jobs: [] }),
      fixture.options,
    );

    expect(
      writeCronJobScratchForMaintenance({
        ...fixture,
        jobId: "job-1",
        content: "orphaned heartbeat scratch",
        expectedRevision: 0,
        nowMs: 10,
      }),
    ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 0 });
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options)).toEqual({
      currentRevision: 0,
    });
  });

  it.each(["retained content", null])(
    "preserves the revision of orphan scratch when rejecting a write (%s)",
    async (content) => {
      const fixture = await createFixture();
      writeCronJobScratchForMaintenance({ ...fixture, jobId: "job-1", content: "initial" });
      writeCronJobScratchForMaintenance({ ...fixture, jobId: "job-1", content });
      const previous = readCronJobScratchState(fixture.storePath, "job-1", fixture.options);
      // Job removal commits before its scratch cleanup, so a late writer can see this state.
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

      expect(
        writeCronJobScratchForMaintenance({
          ...fixture,
          jobId: "job-1",
          content: "late write",
          expectedRevision: previous.currentRevision,
        }),
      ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 2 });
      expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options)).toEqual(
        previous,
      );
    },
  );

  it.each([
    ["write", "notes"],
    ["write", null],
    ["delete", "notes"],
    ["delete", null],
  ] as const)(
    "preserves native timestamp range errors during %s (%s)",
    async (operation, content) => {
      const fixture = await createFixture();
      writeCronJobScratchForMaintenance({ ...fixture, jobId: "job-1", content: "initial" });
      writeCronJobScratchForMaintenance({ ...fixture, jobId: "job-1", content });
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
        operation === "write"
          ? writeCronJobScratchForMaintenance({
              ...fixture,
              jobId: "job-1",
              content: "replacement",
            })
          : deleteCronJobScratch(fixture.storePath, "job-1", fixture.options, {
              expectedRevision: 2,
            }),
      ).toThrow(/too large to be represented as a JavaScript number/);
      expect(stored.get(storeKey, "job-1")).toEqual(before);
    },
  );

  it("records migration provenance and clears it on plain rewrites", async () => {
    const fixture = await createFixture();
    const content = "# Monitor\n\nCheck mail.\n";
    const sourceSha256 = hashCronScratchSource(content);

    writeCronJobScratchForMaintenance({
      ...fixture,
      jobId: "job-1",
      content,
      sourceSha256,
      nowMs: 10,
    });

    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options).scratch).toEqual({
      content,
      revision: 1,
      sourceSha256,
      updatedAtMs: 10,
    });

    writeCronJobScratchForMaintenance({
      ...fixture,
      jobId: "job-1",
      content: "rewritten",
      nowMs: 20,
    });
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options).scratch).toEqual({
      content: "rewritten",
      revision: 2,
      updatedAtMs: 20,
    });
  });

  it("rejects content above the fixed UTF-8 byte limit", async () => {
    const fixture = await createFixture();
    const content = "é".repeat(CRON_JOB_SCRATCH_MAX_BYTES / 2 + 1);

    expect(() =>
      writeCronJobScratchForMaintenance({ ...fixture, jobId: "job-1", content }),
    ).toThrow(`cron scratch exceeds ${CRON_JOB_SCRATCH_MAX_BYTES} bytes`);
  });
});
