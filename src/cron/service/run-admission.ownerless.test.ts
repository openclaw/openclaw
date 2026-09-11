import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  getTotalQueueSize,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { listTaskRegistryRecordsByRuntimeSourceIdFromSqlite } from "../../tasks/task-registry.store.sqlite.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  findActiveCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import type { CronJob } from "../types.js";
import { stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import { enqueueRun, run } from "./ops-run.js";
import { persistQueuedCronRunReservations } from "./run-admission.js";
import type { CronEvent, CronServiceState } from "./state.js";

const NOW = Date.parse("2026-09-06T20:24:00.000Z");
const fixtures = setupCronRegressionFixtures({
  prefix: "cron-reservation-ownerless-",
  baseTimeIso: "2026-09-06T20:24:00.000Z",
});
const states = new Set<CronServiceState>();

afterEach(() => {
  for (const state of states) {
    stop(state);
  }
  states.clear();
  resetTaskRegistryForTests({ persist: false });
});

function commandJob(id: string, nextRunAtMs = NOW): CronJob {
  return {
    ...createDueIsolatedJob({ id, nowMs: NOW, nextRunAtMs }),
    payload: { kind: "command", argv: ["echo", id] },
  };
}

async function setupOwnerlessJob(
  job: CronJob,
  resolveDefaultAgentId = (): string | undefined => undefined,
) {
  const { storePath } = fixtures.makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const events: CronEvent[] = [];
  const finished = createDeferred();
  const execute = vi.fn(async () => ({ status: "ok" as const }));
  const state = createCronRegressionState({
    storePath,
    nowMs: () => Date.now(),
    defaultAgentId: undefined,
    resolveDefaultAgentId,
    runCommandJob: execute,
    runIsolatedAgentJob: execute,
    onEvent: (event) => {
      events.push(structuredClone(event));
      if (event.action === "finished") {
        finished.resolve();
      }
    },
  });
  states.add(state);
  await list(state);
  return { storePath, state, events, execute, finished };
}

function history(storePath: string, jobId: string, runId?: string) {
  return readCronTaskRunHistoryPage({ storeKey: cronStoreKey(storePath), jobId, runId }).entries;
}

function receipts(storePath: string, jobId: string) {
  return openOpenClawStateDatabase()
    .db.prepare("SELECT receipt_id FROM cron_run_receipts WHERE store_key = ? AND job_id = ?")
    .all(cronStoreKey(storePath), jobId);
}

describe("ownerless reservation and manual completion", () => {
  it("keeps an owned sibling reserved while recording only the ownerless scheduled skip", async () => {
    const ownerless = commandJob("ownerless-batch");
    const owned = { ...commandJob("owned-batch"), agentId: "ops" };
    const { state, storePath, events, execute } = await setupOwnerlessJob(ownerless);
    await saveCronStore(storePath, { version: 1, jobs: [ownerless, owned] });
    await list(state);
    const reserved = await persistQueuedCronRunReservations({
      state,
      candidates: [ownerless, owned],
      reservedAtMs: NOW,
    });
    try {
      expect(reserved.map(({ job }) => job.id)).toEqual([owned.id]);
      const persisted = (await loadCronStore(storePath)).jobs;
      expect(persisted.find((job) => job.id === ownerless.id)?.state).toMatchObject({
        lastRunStatus: "skipped",
        lastError: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
      });
      expect(persisted.find((job) => job.id === owned.id)?.state.queuedAtMs).toBe(NOW);
      expect(events.filter((event) => event.action === "finished")).toEqual([
        expect.objectContaining({ jobId: ownerless.id, status: "skipped" }),
      ]);
      expect(history(storePath, ownerless.id)).toEqual([]);
      expect(receipts(storePath, ownerless.id)).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      for (const reservation of reserved) {
        finishCronRunReceipt({
          handle: reservation.runReceipt,
          status: "skipped",
          finishedAtMs: NOW,
        });
      }
    }
  });

  it("records one durable manual skip without an agent, session, or execution receipt", async () => {
    const job = commandJob("ownerless-manual-history", NOW + 3_600_000);
    const { state, storePath, events, execute, finished } = await setupOwnerlessJob(job);
    const revision = resolveCronJobConfigRevision(job);
    const ack = await enqueueRun(state, job.id, "force");
    if (!ack.ok || !("enqueued" in ack) || !ack.enqueued) {
      throw new Error("Expected an acknowledged manual run");
    }
    await finished.promise;
    await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0));
    const terminal = {
      jobId: job.id,
      runId: ack.runId,
      status: "skipped",
      completionStatus: "failed",
      error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
    };
    expect(events.filter((event) => event.action === "finished")).toEqual([
      expect.objectContaining(terminal),
    ]);
    expect(history(storePath, job.id, ack.runId)).toEqual([expect.objectContaining(terminal)]);
    const tasks = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
      runtime: "cron",
      sourceId: job.id,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      scopeKind: "system",
      ownerKey: "",
      requesterSessionKey: "",
      status: "failed",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    expect(tasks[0]?.agentId).toBeUndefined();
    expect(tasks[0]?.requesterAgentId).toBeUndefined();
    expect(tasks[0]?.childSessionKey).toBeUndefined();
    expect(receipts(storePath, job.id)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    const persisted = (await loadCronStore(storePath)).jobs[0]!;
    expect(persisted.enabled).toBe(true);
    expect(persisted.schedule).toEqual(job.schedule);
    expect(persisted.state.nextRunAtMs).toBe(job.state.nextRunAtMs);
    expect(persisted.payload).toEqual(job.payload);
    expect(resolveCronJobConfigRevision(persisted)).toBe(revision);
  });

  it("preserves the original scheduled slot when an ownerless manual run waits past it", async () => {
    const scheduledAt = NOW + 1_000;
    const job = commandJob("ownerless-delayed-manual", scheduledAt);
    const { state, storePath, finished, execute } = await setupOwnerlessJob(job);
    const revision = resolveCronJobConfigRevision(job);
    state.schedulingPaused = true;
    const entered = createDeferred();
    const release = createDeferred();
    setCommandLaneConcurrency(CommandLane.Cron, 1);
    const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      const ack = await enqueueRun(state, job.id, "force");
      if (!ack.ok || !("enqueued" in ack) || !ack.enqueued) {
        throw new Error("Expected an acknowledged delayed run");
      }
      vi.setSystemTime(scheduledAt + 1);
      release.resolve();
      await blocker;
      await finished.promise;
      await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0));
      const persisted = (await loadCronStore(storePath)).jobs[0]!;
      expect(persisted).toMatchObject({
        enabled: true,
        schedule: job.schedule,
        payload: job.payload,
      });
      expect(persisted.state.nextRunAtMs).toBe(scheduledAt);
      expect(resolveCronJobConfigRevision(persisted)).toBe(revision);
      expect(history(storePath, job.id, ack.runId)).toEqual([
        expect.objectContaining({ runId: ack.runId, status: "skipped", nextRunAtMs: scheduledAt }),
      ]);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await blocker;
      clearCommandLane(CommandLane.Cron);
    }
  });

  it("returns ownerless for a direct run without a terminal tracker", async () => {
    const job = commandJob("ownerless-direct");
    const { state, events, execute } = await setupOwnerlessJob(job);
    await expect(run(state, job.id, "force")).resolves.toEqual({
      ok: true,
      ran: false,
      reason: "ownerless",
    });
    expect(events.filter((event) => event.action === "finished")).toEqual([
      expect.objectContaining({
        jobId: job.id,
        status: "skipped",
        error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
      }),
    ]);
    expect(execute).not.toHaveBeenCalled();
  });
});

const changedPlans: Array<{ name: string; change: (job: CronJob) => void }> = [
  {
    name: "enabled state",
    change: (job) => {
      job.enabled = false;
    },
  },
  {
    name: "next run time",
    change: (job) => {
      job.state.nextRunAtMs = NOW + 60_000;
    },
  },
  {
    name: "last run time",
    change: (job) => {
      job.state.lastRunAtMs = NOW - 1;
    },
  },
  {
    name: "last run status",
    change: (job) => {
      job.state.lastRunStatus = "ok";
    },
  },
  {
    name: "configuration revision",
    change: (job) => {
      job.payload = { kind: "command", argv: ["echo", "edited"] };
    },
  },
  {
    name: "queued marker",
    change: (job) => {
      job.state.queuedAtMs = NOW;
    },
  },
  {
    name: "running marker",
    change: (job) => {
      job.state.runningAtMs = NOW;
    },
  },
];

describe("ownerless skip transaction guards", () => {
  it.each(changedPlans)(
    "does not overwrite changed $name or emit a scheduled completion",
    async ({ name, change }) => {
      const planned = commandJob(`ownerless-stale-${name.replaceAll(" ", "-")}`);
      const { state, storePath, events, execute } = await setupOwnerlessJob(planned);
      const current = structuredClone(planned);
      change(current);
      await saveCronStore(storePath, { version: 1, jobs: [current] });
      const before = await loadCronStore(storePath);
      await expect(
        persistQueuedCronRunReservations({ state, candidates: [planned], reservedAtMs: NOW }),
      ).resolves.toEqual([]);
      expect(await loadCronStore(storePath)).toEqual(before);
      expect(events).toEqual([]);
      expect(history(storePath, planned.id)).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("rechecks a restored default owner inside the skip transaction", async () => {
    const job = commandJob("ownerless-restored-owner");
    const { state, storePath, events } = await setupOwnerlessJob(job);
    const before = await loadCronStore(storePath);
    // This controls the internal classification/write boundary, not a public timer race.
    state.deps.resolveDefaultAgentId = vi
      .fn<() => string | undefined>()
      .mockReturnValueOnce(undefined)
      .mockReturnValue("ops");
    await expect(
      persistQueuedCronRunReservations({ state, candidates: [job], reservedAtMs: NOW }),
    ).resolves.toEqual([]);
    expect(await loadCronStore(storePath)).toEqual(before);
    expect(events).toEqual([]);
    expect(history(storePath, job.id)).toEqual([]);
    expect(receipts(storePath, job.id)).toEqual([]);
  });

  it("preserves a live receipt when the default owner becomes unresolved", async () => {
    let owner: string | undefined = "ops";
    const job = commandJob("ownerless-live-receipt");
    const { state, storePath, events, execute } = await setupOwnerlessJob(job, () => owner);
    const prepared = prepareCronRunReceiptClaim({
      storePath,
      job,
      agentId: "ops",
      startedAtMs: NOW,
    });
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabase({
        database: db,
        prepared,
        resolveAgentId: () => "ops",
      }),
    );
    owner = undefined;
    const before = await loadCronStore(storePath);
    try {
      await expect(
        persistQueuedCronRunReservations({ state, candidates: [job], reservedAtMs: NOW }),
      ).resolves.toEqual([]);
      expect(await loadCronStore(storePath)).toEqual(before);
      expect(
        findActiveCronRunReceiptInDatabase({
          database: openOpenClawStateDatabase().db,
          storePath,
          jobId: job.id,
        })?.receiptId,
      ).toBe(receipt.receiptId);
      expect(events).toEqual([]);
      expect(history(storePath, job.id)).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      finishCronRunReceipt({ handle: receipt, status: "skipped", finishedAtMs: NOW });
    }
  });

  it("finishes a rejected manual request once without overwriting the newer scheduled slot", async () => {
    const planned = commandJob("ownerless-rejected-manual", NOW + 60_000);
    const { state, storePath, events } = await setupOwnerlessJob(planned);
    const current = structuredClone(planned);
    current.state.nextRunAtMs = NOW + 120_000;
    await saveCronStore(storePath, { version: 1, jobs: [current] });
    const before = await loadCronStore(storePath);
    const runId = "manual:ownerless-rejected-manual:1";
    const terminalTracker = { emitted: false };
    await expect(
      persistQueuedCronRunReservations({
        state,
        candidates: [planned],
        reservedAtMs: NOW,
        scheduleMode: "preserve",
        manualRun: { runId, terminalTracker, scheduleOwnershipAtMs: NOW },
      }),
    ).resolves.toEqual([]);
    expect(await loadCronStore(storePath)).toEqual(before);
    expect(events.filter((event) => event.action === "finished")).toEqual([
      expect.objectContaining({
        runId,
        status: "skipped",
        error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
      }),
    ]);
    expect(history(storePath, planned.id, runId)).toEqual([
      expect.objectContaining({ runId, status: "skipped", nextRunAtMs: NOW + 120_000 }),
    ]);
    expect(terminalTracker.emitted).toBe(true);
    expect(receipts(storePath, planned.id)).toEqual([]);
  });

  it("rolls back a failed skip commit without publishing a skipped outcome", async () => {
    const job = commandJob("ownerless-rollback");
    const { state, storePath, events, execute } = await setupOwnerlessJob(job);
    const before = await loadCronStore(storePath);
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TEMP TRIGGER reject_ownerless_skip
      BEFORE UPDATE OF state_json ON cron_jobs
      WHEN NEW.job_id = 'ownerless-rollback'
        AND json_extract(NEW.state_json, '$.lastRunStatus') = 'skipped'
      BEGIN
        SELECT RAISE(ABORT, 'ownerless skip commit failed');
      END;
    `);
    try {
      await expect(
        persistQueuedCronRunReservations({ state, candidates: [job], reservedAtMs: NOW }),
      ).rejects.toThrow("ownerless skip commit failed");
      expect(await loadCronStore(storePath)).toEqual(before);
      expect(state.store?.jobs[0]?.state.lastRunStatus).toBeUndefined();
      expect(events).toEqual([]);
      expect(history(storePath, job.id)).toEqual([]);
      expect(receipts(storePath, job.id)).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_ownerless_skip");
    }
  });
});

it.each([
  { mode: "due" as const, enabled: true, reason: "not-due" },
  { mode: "if-enabled" as const, enabled: false, reason: "disabled" },
])(
  "preserves $mode eligibility before recording an ownerless skip",
  async ({ mode, enabled, reason }) => {
    const job = { ...commandJob(`ownerless-${mode}`, NOW + 60_000), enabled };
    const { state, storePath, events, execute } = await setupOwnerlessJob(job);
    const before = await loadCronStore(storePath);
    const eventsBeforeRun = structuredClone(events);
    await expect(run(state, job.id, mode)).resolves.toEqual({ ok: true, ran: false, reason });
    expect(await loadCronStore(storePath)).toEqual(before);
    expect(events).toEqual(eventsBeforeRun);
    expect(history(storePath, job.id)).toEqual([]);
    expect(receipts(storePath, job.id)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  },
);
