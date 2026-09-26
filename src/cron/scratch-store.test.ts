import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createCronMutationCompletion } from "./mutation-completion.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "./scratch-contract.js";
import {
  deleteCronJobScratch,
  hashCronScratchSource,
  readCronJobScratchState,
  writeCronJobScratch,
} from "./scratch-store.js";
import { cronStoreKey } from "./store/key.js";
import { replaceCronRows, upsertCronJobRow } from "./store/row-codec.js";
import { getCronStoreKysely } from "./store/schema.js";
import type { CronJob } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
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
    writeCronJobScratch({ ...fixture, jobId: "job-1", content: "first" });
    writeCronJobScratch({ ...fixture, jobId: "job-1", content: "second" });
    expect(
      writeCronJobScratch({ ...fixture, jobId: "job-2", content: "other", expectedRevision: 0 }),
    ).toMatchObject({ ok: true, currentRevision: 1 });
    expect(
      writeCronJobScratch({ ...fixture, jobId: "job-1", content: "stale", expectedRevision: 1 }),
    ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 2 });
    const otherStore = path.join(path.dirname(fixture.storePath), "other.json");
    expect(
      writeCronJobScratch({
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
        writeCronJobScratch({
          ...fixture,
          jobId: "job-1",
          content: null,
        }),
      ),
    ).resolves.toEqual({ ok: true, currentRevision: 0 });
    expect(absent.isCommitted()).toBe(false);

    const write = createCronMutationCompletion("cron.scratch.set")!;
    await write.run(async () =>
      writeCronJobScratch({
        ...fixture,
        jobId: "job-1",
        content: "committed",
      }),
    );
    expect(write.isCommitted()).toBe(true);

    const conflict = createCronMutationCompletion("cron.scratch.set")!;
    await expect(
      conflict.run(async () =>
        writeCronJobScratch({
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

    const write = writeCronJobScratch({
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
    writeCronJobScratch({ ...fixture, jobId: "job-1", content: "first", nowMs: 10 });

    expect(
      writeCronJobScratch({
        ...fixture,
        jobId: "job-1",
        content: "stale",
        expectedRevision: 0,
        nowMs: 20,
      }),
    ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 1 });

    expect(
      writeCronJobScratch({
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
      writeCronJobScratch({
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
      writeCronJobScratch({
        ...fixture,
        jobId: "job-1",
        content: "resurrected",
        expectedRevision: 2,
        nowMs: 50,
      }),
    ).toEqual({ ok: false, reason: "revision-conflict", currentRevision: 3 });
    expect(
      writeCronJobScratch({
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
      writeCronJobScratch({
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
      writeCronJobScratch({ ...fixture, jobId: "job-1", content: "initial" });
      writeCronJobScratch({ ...fixture, jobId: "job-1", content });
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
        writeCronJobScratch({
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
      writeCronJobScratch({ ...fixture, jobId: "job-1", content: "initial" });
      writeCronJobScratch({ ...fixture, jobId: "job-1", content });
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
          ? writeCronJobScratch({ ...fixture, jobId: "job-1", content: "replacement" })
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

    writeCronJobScratch({
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

    writeCronJobScratch({ ...fixture, jobId: "job-1", content: "rewritten", nowMs: 20 });
    expect(readCronJobScratchState(fixture.storePath, "job-1", fixture.options).scratch).toEqual({
      content: "rewritten",
      revision: 2,
      updatedAtMs: 20,
    });
  });

  it("rejects content above the fixed UTF-8 byte limit", async () => {
    const fixture = await createFixture();
    const content = "é".repeat(CRON_JOB_SCRATCH_MAX_BYTES / 2 + 1);

    expect(() => writeCronJobScratch({ ...fixture, jobId: "job-1", content })).toThrow(
      `cron scratch exceeds ${CRON_JOB_SCRATCH_MAX_BYTES} bytes`,
    );
  });
});
