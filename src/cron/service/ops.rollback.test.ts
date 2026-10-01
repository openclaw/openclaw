// Cron mutation rollback, publication ordering, and failure recovery.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeCronStoreCommits } from "../../../test/helpers/cron/runtime-mutation.js";
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
import { inspectManualRunDisposition } from "./ops-run-preparation.js";
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
    run: () => Promise<void>,
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
      await run();
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

  it("rolls back an added job from the live store when persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    await writeCronStoreSnapshot({ storePath, jobs: [] });
    await withCronJobWriteFailure(storePath, async () => {
      await expect(add(state, makeCreateInput("daily cleanup"))).rejects.toThrow("disk full");
    });

    expect(state.timer).toBeNull();
    expect(state.store?.jobs ?? []).toEqual([]);
    const listed = await list(state, { includeDisabled: true });
    if (state.timer) {
      state.timer.cancel();
    }
    expect(listed).toEqual([]);
    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs).toEqual([]);
  });

  it("keeps the pre-update job in the live store when persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      state.timer.cancel();
    }

    await withCronJobWriteFailure(storePath, async () => {
      await expect(update(state, job.id, { name: "renamed cleanup" })).rejects.toThrow("disk full");
    });

    const inMemory = state.store?.jobs.find((entry) => entry.id === job.id);
    expect(inMemory?.name).toBe("daily cleanup");
    const loaded = await loadCronStore(storePath);
    const stored = loaded.jobs.find((entry) => entry.id === job.id);
    expect(stored?.name).toBe("daily cleanup");
  });

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

  it("keeps a removed job in the live store when persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      state.timer.cancel();
    }

    await withCronJobWriteFailure(storePath, async () => {
      await expect(remove(state, job.id)).rejects.toThrow("disk full");
    });

    expect(state.store?.jobs.map((entry) => entry.id)).toEqual([job.id]);
    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs.map((entry) => entry.id)).toEqual([job.id]);
  });

  it("restores a job's catch-up deferral when a remove persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      state.timer.cancel();
    }
    job.state.startupCatchupAtMs = now + 5_000;

    await withCronJobWriteFailure(storePath, async () => {
      await expect(remove(state, job.id)).rejects.toThrow("disk full");
    });

    expect(state.store?.jobs[0]?.state.startupCatchupAtMs).toBe(now + 5_000);
    expect(state.store?.jobs.map((entry) => entry.id)).toEqual([job.id]);
  });

  it("recovers after a failed persist so the next mutation succeeds", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    await writeCronStoreSnapshot({ storePath, jobs: [] });
    await withCronJobWriteFailure(storePath, async () => {
      await expect(add(state, makeCreateInput("daily cleanup"))).rejects.toThrow("disk full");
    });
    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      state.timer.cancel();
    }

    const listed = await list(state, { includeDisabled: true });
    if (state.timer) {
      state.timer.cancel();
    }
    expect(listed.map((entry) => entry.id)).toEqual([job.id]);
    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs.map((entry) => entry.id)).toEqual([job.id]);
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
        expect(persisted.jobs.find((job) => job.id === removed.id)).toBeUndefined();
        expect(persisted.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(false);
        if (outcome === "failed") {
          throw new Error("roster commit failed");
        }
        if (outcome === "uncertain") {
          throw new AgentDeletionCommitUncertainError(new Error("roster commit uncertain"));
        }
        return "roster committed";
      });
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
      const notificationCount = rolledBack ? 0 : 1;
      expect(commit).toHaveBeenCalledOnce();
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
      await expect(inspectManualRunDisposition(state, job.id)).resolves.toEqual({
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
