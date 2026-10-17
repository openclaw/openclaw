import assert from "node:assert/strict";
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
import type { CronJob } from "./types.js";

const tempDirs: string[] = [];
const scratchReceipt = () =>
  expectDefined(createCronMutationCompletion("cron.scratch.set"), "scratch receipt");
const conflict = (currentRevision: number) => ({
  ok: false,
  reason: "revision-conflict",
  currentRevision,
});
const written = (content: string | null, revision: number, updatedAtMs?: number) => ({
  ok: true,
  currentRevision: revision,
  ...(content !== null
    ? { scratch: { content, revision, ...(updatedAtMs === undefined ? {} : { updatedAtMs }) } }
    : {}),
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

function scratchAccess(service: CronService, job: CronJob, storePath: string) {
  return {
    read: () => service.readScratch(job.id),
    stored: () => readCronJobScratchState(storePath, job.id),
    write: (content: string | null, expectedRevision: number, commitGuard?: () => void) =>
      service.writeScratch(job.id, { content, expectedRevision, commitGuard }),
  };
}

async function withoutCallerSql<T>(run: () => Promise<T>) {
  const sql = observeMainThreadSql();
  try {
    sql.calibrate();
    const result = await run();
    expect(sql.count()).toBe(0);
    return result;
  } finally {
    sql.restore();
  }
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type ScratchFixture = ReturnType<typeof scratchAccess> & {
  service: CronService;
  job: CronJob;
  storePath: string;
  databasePath: string;
};
async function withScratchService(run: (fixture: ScratchFixture) => Promise<void>) {
  await withOpenClawTestState({ label: "cron-scratch-worker" }, async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const service = createService(storePath, () => 1_000);
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
        ...scratchAccess(service, job, storePath),
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
      expect(
        verification
          .prepare(
            "SELECT (SELECT COUNT(*) FROM cron_jobs) AS jobs, (SELECT COUNT(*) FROM cron_job_scratch) AS scratch",
          )
          .get(),
      ).toEqual({ jobs: 0, scratch: 0 });
    });
  });

  it("reads a legacy creation fallback without ignoring a persisted definition change", async () => {
    await withScratchService(async ({ write, job, storePath, databasePath }) => {
      await write("legacy private content", 0);
      const reader = createService(storePath);
      const { read, write: rewrite } = scratchAccess(reader, job, storePath);
      using peer = new DatabaseSync(databasePath);
      try {
        const key = cronStoreKey(storePath);
        const row = peer
          .prepare("SELECT job_json FROM cron_jobs WHERE store_key = ? AND job_id = ?")
          .get(key, job.id);
        const definition = expectDefined(row, "stored scratch job").job_json;
        assert(typeof definition === "string");
        const { createdAtMs: _createdAtMs, ...legacy } = expectDefined(
          safeParseJsonRecord(definition),
          "stored scratch job definition",
        );
        // Direct fixture corruption models a legacy row without invoking the writer's normalization.
        const update = peer.prepare(
          "UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?",
        );
        const writeDefinition = (value: unknown) => update.run(JSON.stringify(value), key, job.id);
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
        expect(await read()).toMatchObject({
          currentRevision: 1,
          scratch: { content: "legacy private content" },
        });
        expect(await rewrite("updated legacy private content", 1)).toMatchObject({
          ok: true,
          currentRevision: 2,
        });
        writeDefinition({ ...legacy, createdAtMs: loaded.createdAtMs + 1_000 });
        await expect(read()).rejects.toThrow("changed after it was read");
      } finally {
        reader.stop();
      }
    });
  });

  it("writes off the caller thread while preserving CAS, tombstones, and actual-write receipts", async () => {
    await withScratchService(async ({ service, job, write, read }) => {
      for (const [content, expectedRevision, expected, committed] of [
        [null, 0, written(null, 0), false],
        ["scheduled café", 0, written("scheduled café", 1), true],
        [null, 1, written(null, 2), true],
        ["stale resurrection", 1, conflict(2), false],
      ] as const) {
        const completion = scratchReceipt();
        await withoutCallerSql(async () => {
          const result = await completion.run(() =>
            write(content, expectedRevision, () =>
              expect(service.getJob(job.id)?.agentId).toBe("alpha"),
            ),
          );
          expect(result).toMatchObject(expected);
          if (expected.currentRevision === 1) {
            expect(await read()).toMatchObject({
              currentRevision: 1,
              scratch: { content: "scheduled café", revision: 1 },
            });
          }
          expect(completion.isCommitted()).toBe(committed);
        });
      }
      expect(await read()).toEqual({ currentRevision: 2 });
    });
  });

  it.each([
    { change: "caller revocation", boundary: "queued before dispatch" },
    { change: "job owner replacement", boundary: "queued before admission" },
  ] as const)("refuses scratch after $change ($boundary)", async ({ change }) => {
    await withScratchService(async ({ service, job, storePath, databasePath, write, stored }) => {
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
      const pending = completion
        .run(() =>
          write("must not commit", 1, () => {
            if (!callerCurrent) {
              throw new Error("scratch caller revoked");
            }
            expect(service.getJob(job.id)?.agentId).toBe("alpha");
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
          {
            using peer = new DatabaseSync(databasePath);
            runSqliteImmediateTransactionSync(peer, () => {
              upsertCronJobRow(peer, cronStoreKey(storePath), { ...job, agentId: "beta" }, 0);
            });
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
        expect(stored()).toMatchObject({
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
    await withScratchService(async ({ write, stored }) => {
      const completion = scratchReceipt();
      const dropped = loseFirstCronMutationReply("cron.writeScratch");
      try {
        const result = await completion
          .run(() => write("committed once", 0))
          .then(
            () => "reported",
            () => "reply-lost",
          );
        expect(result).toBe("reply-lost");
        expect(dropped.wasDropped()).toBe(true);
        expect(dropped.attempts).toEqual(["cron.writeScratch"]);
        await dropped.waitForExit();
        expect(completion.isCommitted()).toBe(false);
        expect(stored()).toMatchObject({
          currentRevision: 1,
          scratch: { content: "committed once", revision: 1 },
        });
      } finally {
        await dropped.close();
      }
    });
  });
});

type MaintenanceWrite = Parameters<typeof writeCronJobScratchForMaintenance>[0];
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
          MaintenanceWrite,
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
    expect(fixture.write("stale", { expectedRevision: 1 })).toEqual(conflict(2));
    const storePath = path.join(path.dirname(fixture.storePath), "other.json");
    expect(fixture.write("orphan", { storePath, expectedRevision: 0 })).toEqual(conflict(0));
    expect(fixture.read("job-1", storePath)).toEqual({ currentRevision: 0 });
    expect(fixture.read().scratch?.content).toBe("second");
  });

  it("preserves CAS, tombstones, guarded removal, and receipts only for actual writes", async () => {
    const fixture = await createFixture();
    expect(fixture.read()).toEqual({ currentRevision: 0 });
    for (const [content, expectedRevision, nowMs, expected, committed] of [
      [null, undefined, 0, written(null, 0), false],
      ["", undefined, 10, written("", 1, 10), true],
      ["stale", 0, 20, conflict(1), false],
      ["second", 1, 30, written("second", 2, 30), true],
      [null, 2, 40, written(null, 3), true],
      ["resurrected", 2, 50, conflict(3), false],
      ["recreated", 3, 60, written("recreated", 4, 60), true],
    ] as const) {
      const completion = scratchReceipt();
      expect(
        await completion.run(async () => fixture.write(content, { expectedRevision, nowMs })),
      ).toEqual(expected);
      expect(completion.isCommitted()).toBe(committed);
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
      conflict(0),
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
          db
            .prepare("DELETE FROM cron_jobs WHERE store_key = ? AND job_id = ?")
            .run(cronStoreKey(fixture.storePath), "job-1"),
        fixture.options,
      );
      expect(fixture.write("late write", { expectedRevision: previous.currentRevision })).toEqual(
        conflict(2),
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
