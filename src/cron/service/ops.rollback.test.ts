// Cron mutation rollback, publication ordering, and failure recovery.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeCronStoreCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { AgentDeletionCommitUncertainError } from "../../agents/agent-lifecycle-registry.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as cronSchedule from "../schedule.js";
import { readCronJobScratchState, writeCronJobScratch } from "../scratch-store.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { add, remove, removeAgentJobsTransactional, update } from "./ops-mutations.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";
import { createOkIsolatedCronStateFactory } from "./ops.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-ops-rollback",
});
const createOkIsolatedCronState = createOkIsolatedCronStateFactory(logger);

describe("cron service ops persist rollback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCreateInput(name: string) {
    return {
      name,
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
    } as const;
  }

  async function withCronJobWriteFailure(
    storePath: string,
    mutate: () => Promise<void>,
  ): Promise<void> {
    const database = openOpenClawStateDatabase().db;
    const storeKey = cronStoreKey(storePath).replaceAll("'", "''");
    const triggers = ["INSERT", "UPDATE", "DELETE"].map((operation) => {
      const name = `ops_fail_cron_${operation.toLowerCase()}`;
      const row = operation === "DELETE" ? "OLD" : "NEW";
      database.exec(`
        CREATE TRIGGER ${name}
        AFTER ${operation} ON cron_jobs
        WHEN ${row}.store_key = '${storeKey}'
        BEGIN
          SELECT RAISE(ABORT, 'disk full');
        END;
      `);
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
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const onEvent = vi.fn();
    const state = createOkIsolatedCronState({ storePath, now, onEvent });
    const job = await add(state, makeCreateInput("daily cleanup"));
    const previousRevision = cronStoreModule.getCronJobsStoreRevision(storePath);
    const originalTimer = state.timer;
    onEvent.mockClear();
    const committed = vi.fn();
    onTestFinished(observeCronStoreCommits(storePath, committed));

    await expect(remove(state, "missing-job")).resolves.toEqual({ ok: true, removed: false });

    expect(committed).not.toHaveBeenCalled();
    expect(cronStoreModule.getCronJobsStoreRevision(storePath)).toBe(previousRevision);
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.timer).toBe(originalTimer);
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
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-06-09T00:00:00.000Z");
      const state = createOkIsolatedCronState({ storePath, now });
      const job =
        operation === "add" ? undefined : await add(state, makeCreateInput("daily cleanup"));
      state.timer?.cancel();
      if (job && operation === "remove") {
        job.state.startupCatchupAtMs = now + 5_000;
      }
      if (!job) {
        await writeCronStoreSnapshot({ storePath, jobs: [] });
      }
      const liveBefore = structuredClone(state.store?.jobs ?? []);
      const durableBefore = (await loadCronStore(storePath)).jobs;
      await withCronJobWriteFailure(storePath, async () => {
        const mutation = job
          ? operation === "update"
            ? update(state, job.id, { name: "renamed cleanup" })
            : remove(state, job.id)
          : add(state, makeCreateInput("daily cleanup"));
        await expect(mutation).rejects.toThrow("disk full");
      });
      expect(state.store?.jobs ?? []).toEqual(liveBefore);
      expect((await loadCronStore(storePath)).jobs).toEqual(durableBefore);
      if (job && operation === "update") {
        expect(state.store?.jobs.find((entry) => entry.id === job.id)?.name).toBe("daily cleanup");
        expect(
          (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id)?.name,
        ).toBe("daily cleanup");
      }
      if (job && operation === "remove") {
        expect(state.store?.jobs[0]?.state.startupCatchupAtMs).toBe(now + 5_000);
      }
      if (!job) {
        expect(state.timer).toBeNull();
        expect(await list(state, { includeDisabled: true })).toEqual([]);
        state.timer?.cancel();
        const recovered = await add(state, makeCreateInput("daily cleanup"));
        state.timer?.cancel();
        expect((await list(state, { includeDisabled: true })).map((entry) => entry.id)).toEqual([
          recovered.id,
        ]);
        state.timer?.cancel();
        expect((await loadCronStore(storePath)).jobs.map((entry) => entry.id)).toEqual([
          recovered.id,
        ]);
      }
    },
  );

  it("does not clone the store before a missing or invalid update reaches commit", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const job = await add(state, makeCreateInput("daily cleanup"));
    const clone = vi.spyOn(globalThis, "structuredClone");

    await expect(update(state, "missing-job", { name: "missing" })).rejects.toThrow(
      "unknown cron job id",
    );
    await expect(
      update(state, job.id, { schedule: { kind: "cron", expr: "0 0 30 2 *" } }),
    ).rejects.toThrow(/no upcoming run time/);

    expect(clone).not.toHaveBeenCalledWith(state.store);
    if (state.timer) {
      state.timer.cancel();
    }
  });

  it.each(["mutation"] as const)(
    "notifies about schedule auto-disable only after %s persists",
    async (triggerPath) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-06-09T00:00:00.000Z");
      const state = createOkIsolatedCronState({ storePath, now });

      const malformed = await add(state, {
        ...makeCreateInput("malformed sibling"),
        schedule: { kind: "cron", expr: "0 1 * * *" },
      });
      if (state.timer) {
        state.timer.cancel();
      }
      malformed.state.nextRunAtMs = undefined;
      malformed.state.scheduleErrorCount = 2;
      const enqueueSystemEvent = vi.mocked(state.deps.enqueueSystemEvent);
      const requestHeartbeat = vi.mocked(state.deps.requestHeartbeat);
      const order: string[] = [];
      enqueueSystemEvent.mockClear();
      requestHeartbeat.mockClear();
      enqueueSystemEvent.mockImplementation(() => {
        order.push("notify");
      });
      requestHeartbeat.mockImplementation(() => {
        order.push("heartbeat");
      });
      const computeNextRunAtMs = cronSchedule.computeNextRunAtMs;
      vi.spyOn(cronSchedule, "computeNextRunAtMs").mockImplementation((schedule, nowMs) => {
        if (schedule.kind === "cron" && schedule.expr === "0 1 * * *") {
          throw new Error("simulated schedule failure");
        }
        return computeNextRunAtMs(schedule, nowMs);
      });

      const trigger = () => add(state, makeCreateInput(`trigger ${triggerPath}`));
      await withCronJobWriteFailure(storePath, async () => {
        await expect(trigger()).rejects.toThrow("disk full");
      });

      expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(true);
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();

      const stopObserving = observeCronStoreCommits(storePath, () => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();
        const persisted = openOpenClawStateDatabase()
          .db.prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
          .get(cronStoreKey(storePath), malformed.id);
        expect(persisted).toEqual({ enabled: 0 });
        order.push("persist");
      });
      try {
        await trigger();
      } finally {
        stopObserving();
      }
      if (state.timer) {
        state.timer.cancel();
      }

      expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(false);
      expect(order).toEqual(["persist", "notify", "heartbeat"]);
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
      expect(requestHeartbeat).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["failed", "committed", "uncertain"] as const)(
    "publishes agent-removal auto-disable notifications only after a %s roster outcome",
    async (outcome) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-06-09T00:00:00.000Z");
      const state = createOkIsolatedCronState({ storePath, now });
      const removed = await add(state, {
        ...makeCreateInput("deleted agent job"),
        agentId: "doomed",
      });
      expect(
        await writeCronJobScratch({
          storePath,
          jobId: removed.id,
          content: "deleted agent scratch",
          sourceSha256: "deleted-agent-source",
          nowMs: now - 1,
        }),
      ).toMatchObject({ ok: true, currentRevision: 1 });
      const scratchBefore = readCronJobScratchState(storePath, removed.id);
      const malformed = await add(state, {
        ...makeCreateInput("malformed surviving job"),
        agentId: "survivor",
        schedule: { kind: "cron", expr: "0 1 * * *" },
      });
      if (state.timer) {
        state.timer.cancel();
      }
      malformed.state.nextRunAtMs = undefined;
      malformed.state.scheduleErrorCount = 2;
      const enqueueSystemEvent = vi.mocked(state.deps.enqueueSystemEvent);
      const requestHeartbeat = vi.mocked(state.deps.requestHeartbeat);
      enqueueSystemEvent.mockClear();
      requestHeartbeat.mockClear();
      const computeNextRunAtMs = cronSchedule.computeNextRunAtMs;
      vi.spyOn(cronSchedule, "computeNextRunAtMs").mockImplementation((schedule, nowMs) => {
        if (schedule.kind === "cron" && schedule.expr === "0 1 * * *") {
          throw new Error("simulated schedule failure");
        }
        return computeNextRunAtMs(schedule, nowMs);
      });

      const commit = vi.fn(async () => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();
        const persisted = await loadCronStore(storePath);
        expect(persisted.jobs.find((job) => job.id === removed.id)?.agentId).toBe("doomed");
        expect(persisted.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(true);
        expect(readCronJobScratchState(storePath, removed.id)).toEqual(scratchBefore);
        if (outcome === "failed") {
          throw new Error("roster commit failed");
        }
        if (outcome === "uncertain") {
          throw new AgentDeletionCommitUncertainError(new Error("roster commit uncertain"));
        }
        return "roster committed";
      });
      const scratchWrites = trackSqliteStatementExecutions(
        openOpenClawStateDatabase().db,
        ["deletes"] as const,
        (sql) => (sql.includes('delete from "cron_job_scratch"') ? "deletes" : null),
      );
      onTestFinished(scratchWrites.restore);
      if (outcome !== "failed") {
        await withCronJobWriteFailure(storePath, async () => {
          const first = removeAgentJobsTransactional(state, "doomed", commit);
          if (outcome === "uncertain") {
            await expect(first).rejects.toBeInstanceOf(AgentDeletionCommitUncertainError);
          } else {
            await expect(first).rejects.toThrow(
              "Agent roster committed, but cron cleanup did not complete",
            );
          }
        });
        expect((await loadCronStore(storePath)).jobs.some((job) => job.id === removed.id)).toBe(
          true,
        );
        expect(readCronJobScratchState(storePath, removed.id)).toEqual(scratchBefore);
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();
      }
      const transaction = removeAgentJobsTransactional(state, "doomed", commit);
      if (outcome === "committed") {
        await expect(transaction).resolves.toBe("roster committed");
      } else if (outcome === "uncertain") {
        await expect(transaction).rejects.toBeInstanceOf(AgentDeletionCommitUncertainError);
      } else {
        await expect(transaction).rejects.toThrow("roster commit failed");
      }
      if (state.timer) {
        state.timer.cancel();
      }

      const rolledBack = outcome === "failed";
      expect(scratchWrites.counts.deletes).toBe(0);
      const notificationCount = rolledBack ? 0 : 1;
      expect(commit).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 2);
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(notificationCount);
      expect(requestHeartbeat).toHaveBeenCalledTimes(notificationCount);
      expect(state.store?.jobs.some((job) => job.id === removed.id)).toBe(rolledBack);
      expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(rolledBack);
      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs.some((job) => job.id === removed.id)).toBe(rolledBack);
      expect(persisted.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(rolledBack);
      expect(readCronJobScratchState(storePath, removed.id)).toEqual(
        rolledBack ? scratchBefore : { currentRevision: 0 },
      );
      if (!rolledBack) {
        const replacement = await add(state, {
          ...makeCreateInput("same-id replacement"),
          id: removed.id,
          agentId: "survivor",
        });
        expect(replacement.id).toBe(removed.id);
        expect(readCronJobScratchState(storePath, removed.id)).toEqual({ currentRevision: 0 });
        if (state.timer) {
          state.timer.cancel();
        }
      }
    },
  );

  it("does not auto-disable a job during manual-run preflight", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const job = await add(state, {
      ...makeCreateInput("preflight schedule failure"),
      schedule: { kind: "cron", expr: "0 1 * * *" },
    });
    if (state.timer) {
      state.timer.cancel();
    }
    job.state.nextRunAtMs = undefined;
    job.state.scheduleErrorCount = 2;
    const before = structuredClone(job);
    const persistedBefore = structuredClone(
      (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id),
    );
    const enqueueSystemEvent = vi.mocked(state.deps.enqueueSystemEvent);
    const requestHeartbeat = vi.mocked(state.deps.requestHeartbeat);
    enqueueSystemEvent.mockClear();
    requestHeartbeat.mockClear();
    const computeSpy = vi.spyOn(cronSchedule, "computeNextRunAtMs").mockImplementation(() => {
      throw new Error("simulated preflight schedule failure");
    });

    try {
      await expect(run(state, job.id)).resolves.toEqual({
        ok: true,
        ran: false,
        reason: "not-due",
      });
      expect(job).toEqual(before);
      expect((await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id)).toEqual(
        persistedBefore,
      );
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
    } finally {
      computeSpy.mockRestore();
    }
  });
});
