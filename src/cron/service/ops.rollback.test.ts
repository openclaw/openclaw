import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeCronStoreCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { AgentDeletionCommitUncertainError } from "../../agents/agent-lifecycle-registry.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import * as cronSchedule from "../schedule.js";
import { readCronJobScratchState, writeCronJobScratch } from "../scratch-store.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJobCreate } from "../types.js";
import { add, remove, removeAgentJobsTransactional, update } from "./ops-mutations.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";
import { createOkIsolatedCronStateFactory } from "./ops.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-ops-rollback",
});
const createOkIsolatedCronState = createOkIsolatedCronStateFactory(logger);

describe("cron service ops persist rollback", () => {
  const now = Date.parse("2026-06-09T00:00:00.000Z");
  let storePath: string;
  let state: ReturnType<typeof createOkIsolatedCronState>;
  beforeEach(async () => {
    ({ storePath } = await makeStorePath());
    state = createOkIsolatedCronState({ storePath, now });
  });
  const readJob = async (id: string) =>
    (await loadCronStore(storePath)).jobs.find((entry) => entry.id === id);
  const readJobs = async () => [state.store?.jobs ?? [], (await loadCronStore(storePath)).jobs];
  function notifications() {
    const callback = vi.mocked(state.deps.enqueueSessionEvent!);
    callback.mockClear();
    const expectCalls = (count = 0) => {
      expect(callback).toHaveBeenCalledTimes(count);
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    };
    return { callback, expectCalls };
  }
  async function malformedJob(name: string, agentId?: string) {
    const job = await createJob({ name, agentId, schedule: { kind: "cron", expr: "0 1 * * *" } });
    job.schedule = { kind: "cron", expr: "not a cron" };
    job.state.nextRunAtMs = undefined;
    job.state.scheduleErrorCount = 2;
    await writeCronStoreSnapshot({ storePath, jobs: state.store?.jobs ?? [] });
    return job;
  }
  afterEach(vi.restoreAllMocks);

  function createJob(input: Partial<CronJobCreate> = {}) {
    return add(state, {
      name: "daily cleanup",
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
      ...input,
    });
  }

  async function withCronJobWriteFailure(mutate: () => Promise<void>) {
    const database = openOpenClawStateDatabase().db;
    const storeKey = cronStoreKey(storePath).replaceAll("'", "''");
    const triggers = ["INSERT", "UPDATE", "DELETE"].map((operation) => {
      const name = `ops_fail_cron_${operation.toLowerCase()}`;
      const row = operation === "DELETE" ? "OLD" : "NEW";
      database.exec(`CREATE TRIGGER ${name} AFTER ${operation} ON cron_jobs
        WHEN ${row}.store_key = '${storeKey}' BEGIN
          SELECT RAISE(ABORT, 'disk full'); END;`);
      return name;
    });
    try {
      await mutate();
    } finally {
      for (const name of triggers) {
        database.exec(`DROP TRIGGER ${name}`);
      }
    }
  }

  it("does not persist, re-arm, or notify when removing a missing job", async () => {
    const onEvent = vi.fn();
    state = createOkIsolatedCronState({ storePath, now, onEvent });
    const job = await createJob();
    const previousRevision = cronStoreModule.getCronJobsStoreRevision(storePath);
    onEvent.mockClear();
    const committed = vi.fn();
    onTestFinished(observeCronStoreCommits(storePath, committed));

    await expect(remove(state, "missing-job")).resolves.toEqual({ ok: true, removed: false });

    expect(committed).not.toHaveBeenCalled();
    expect(cronStoreModule.getCronJobsStoreRevision(storePath)).toBe(previousRevision);
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.store?.jobs.map((entry) => entry.id)).toEqual([job.id]);
    expect((await loadCronStore(storePath)).jobs.map((entry) => entry.id)).toEqual([job.id]);

    await expect(remove(state, job.id)).resolves.toEqual({ ok: true, removed: true });

    expect(committed).toHaveBeenCalledOnce();
    expect(cronStoreModule.getCronJobsStoreRevision(storePath)).toBeGreaterThan(previousRevision);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, action: "removed" }),
    );
    expect((await loadCronStore(storePath)).jobs).toEqual([]);
  });

  it.each(["add", "update", "remove"] as const)(
    "rolls back a failed %s in live and durable state",
    async (operation) => {
      const job = operation === "add" ? undefined : await createJob();
      if (job && operation === "remove") {
        job.state.startupCatchupAtMs = now + 5_000;
      }
      if (!job) {
        await writeCronStoreSnapshot({ storePath, jobs: [] });
      }
      const before = structuredClone(await readJobs());
      await withCronJobWriteFailure(async () => {
        const mutation = job
          ? operation === "update"
            ? update(state, job.id, { name: "renamed cleanup" })
            : remove(state, job.id)
          : createJob();
        await expect(mutation).rejects.toThrow("disk full");
      });
      expect(await readJobs()).toEqual(before);
      if (!job) {
        expect(await list(state, { includeDisabled: true })).toEqual([]);
        const recovered = await createJob();
        for (const jobs of [
          await list(state, { includeDisabled: true }),
          (await loadCronStore(storePath)).jobs,
        ]) {
          expect(jobs.map(({ id }) => id)).toEqual([recovered.id]);
        }
      }
    },
  );

  it("does not clone the store before a missing or invalid update reaches commit", async () => {
    const job = await createJob();
    const clone = vi.spyOn(globalThis, "structuredClone");

    await expect(update(state, "missing-job", { name: "missing" })).rejects.toThrow(
      "unknown cron job id",
    );
    await expect(
      update(state, job.id, { schedule: { kind: "cron", expr: "0 0 30 2 *" } }),
    ).rejects.toThrow(/no upcoming run time/);

    expect(clone).not.toHaveBeenCalledWith(state.store);
  });

  it("notifies about schedule auto-disable only after mutation persists", async () => {
    const malformed = await malformedJob("malformed sibling");
    const { callback, expectCalls } = notifications();
    const order: string[] = [];
    callback.mockImplementation(() => {
      order.push("notify");
    });
    await withCronJobWriteFailure(() => expect(createJob()).rejects.toThrow("disk full"));

    expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(true);
    expectCalls();

    const stopObserving = observeCronStoreCommits(storePath, () => {
      expectCalls();
      const persisted = openOpenClawStateDatabase()
        .db.prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
        .get(cronStoreKey(storePath), malformed.id);
      expect(persisted).toEqual({ enabled: 0 });
      order.push("persist");
    });
    onTestFinished(stopObserving);
    await createJob();

    expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(false);
    expect(order).toEqual(["persist", "notify"]);
  });

  it.each(["failed", "committed", "uncertain"] as const)(
    "publishes agent-removal auto-disable notifications only after a %s roster outcome",
    async (outcome) => {
      const removed = await createJob({ name: "deleted agent job", agentId: "doomed" });
      expect(
        await writeCronJobScratch({
          storePath,
          jobId: removed.id,
          content: "deleted agent scratch",
          sourceSha256: "deleted-agent-source",
          nowMs: now - 1,
        }),
      ).toMatchObject({ ok: true, currentRevision: 1 });
      const scratch = () => readCronJobScratchState(storePath, removed.id);
      const scratchBefore = scratch();
      const malformed = await malformedJob("malformed surviving job", "survivor");
      const { expectCalls } = notifications();
      const commit = vi.fn(async () => {
        expectCalls();
        const persisted = await loadCronStore(storePath);
        expect(persisted.jobs.find((job) => job.id === removed.id)?.agentId).toBe("doomed");
        expect(persisted.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(true);
        expect(scratch()).toEqual(scratchBefore);
        if (outcome === "failed") {
          throw new Error("roster commit failed");
        }
        if (outcome === "uncertain") {
          throw new AgentDeletionCommitUncertainError(new Error("roster commit uncertain"));
        }
        return "roster committed";
      });
      const scratchWrites = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(openOpenClawStateDatabase().db),
        ["deletes"] as const,
        (sql) => (sql.includes('delete from "cron_job_scratch"') ? "deletes" : null),
      );
      onTestFinished(scratchWrites.restore);
      const removeAgent = async (cleanupFails = false) => {
        const pending = removeAgentJobsTransactional(state, "doomed", commit);
        if (outcome === "committed" && !cleanupFails) {
          await expect(pending).resolves.toBe("roster committed");
        } else {
          await expect(pending).rejects.toThrow(
            outcome === "uncertain"
              ? AgentDeletionCommitUncertainError
              : cleanupFails
                ? "Agent roster committed, but cron cleanup did not complete"
                : "roster commit failed",
          );
        }
      };
      if (outcome !== "failed") {
        await withCronJobWriteFailure(() => removeAgent(true));
        expect(await readJob(removed.id)).toBeDefined();
        expect(scratch()).toEqual(scratchBefore);
        expectCalls();
      }
      await removeAgent();
      const rolledBack = outcome === "failed";
      expect(scratchWrites.counts.deletes).toBe(0);
      expect(commit).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 2);
      expectCalls(rolledBack ? 0 : 1);
      for (const jobs of await readJobs()) {
        expect([
          jobs.some((job) => job.id === removed.id),
          jobs.find((job) => job.id === malformed.id)?.enabled,
        ]).toEqual([rolledBack, rolledBack]);
      }
      expect(scratch()).toEqual(rolledBack ? scratchBefore : { currentRevision: 0 });
      if (!rolledBack) {
        const replacement = await createJob({ id: removed.id, agentId: "survivor" });
        expect(replacement.id).toBe(removed.id);
        expect(scratch()).toEqual({ currentRevision: 0 });
      }
    },
  );

  it("does not auto-disable a job during manual-run preflight", async () => {
    const job = await createJob({ schedule: { kind: "cron", expr: "0 1 * * *" } });
    job.state.nextRunAtMs = undefined;
    job.state.scheduleErrorCount = 2;
    const before = structuredClone(await readJobs());
    const { expectCalls } = notifications();
    vi.spyOn(cronSchedule, "computeNextRunAtMs").mockImplementation(() => {
      throw new Error("simulated preflight schedule failure");
    });

    await expect(run(state, job.id)).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    expect(job).toEqual(before[0]?.[0]);
    expect(await readJobs()).toEqual(before);
    expectCalls();
  });
});
