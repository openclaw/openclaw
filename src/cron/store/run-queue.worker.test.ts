import { afterAll, beforeAll, expect, it } from "vitest";
import { loseFirstCronMutationReply } from "../../../test/helpers/cron/runtime-mutation.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { projectCronRunHistoryPage } from "../run-history.js";
import { saveCronStore } from "../store.js";
import type { CronJob, CronStoreFile } from "../types.js";
import { readCronRunRecords } from "./read-only.js";
import type { CronRunQueueOperations, CronRunRequestContext } from "./run-queue.types.js";
import { createCronScheduledRunId } from "./run-request-id.js";
import { prepareCronStoreChanges } from "./save.kernel.js";

const now = 1_800_000_000_000;
let fixture: OpenClawTestState;
let context: OpenClawStateWorkerContext;

beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "cron-worker-queue" });
  context = captureOpenClawStateWorkerContext();
  await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
});

afterAll(async () => {
  await fixture?.cleanup();
});

function job(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: id,
    agentId: "main",
    enabled: true,
    createdAtMs: now - 1000,
    updatedAtMs: now - 1000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["echo", id] },
    delivery: { mode: "none" },
    state: { nextRunAtMs: now },
    ...overrides,
  };
}

async function store(label: string, jobs: CronJob[]) {
  const storeKey = fixture.statePath("cron", `${label}.json`);
  await saveCronStore(storeKey, { version: 1, jobs });
  const read = async () => {
    const result = await executeOpenClawStateWorker(context, {
      type: "cron.loadMutable",
      input: { storeKey },
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.loaded.store;
  };
  return {
    storeKey,
    read,
    request: (requests: CronRunQueueOperations["cron.requestRuns"]["input"]["requests"]) =>
      executeOpenClawStateWorker(context, {
        type: "cron.requestRuns",
        input: { storeKey, nowMs: now, requests },
      }),
    drain: (
      requests: CronRunRequestContext[] = [],
      maxConcurrentRuns = 1,
      schedulingPaused = false,
    ) =>
      executeOpenClawStateWorker(context, {
        type: "cron.drainQueue",
        input: { storeKey, nowMs: now + 1, requests, maxConcurrentRuns, schedulingPaused },
      }),
    cancel: (receiptIds: string[], status?: "skipped" | "superseded") =>
      executeOpenClawStateWorker(context, {
        type: "cron.cancelRequests",
        input: { storeKey, receiptIds, nowMs: now + 2, reason: "synthetic cancellation", status },
      }),
    edit: async (mutate: (next: CronStoreFile) => void) => {
      const previous = await read();
      const next = structuredClone(previous);
      mutate(next);
      return executeOpenClawStateWorker(context, {
        type: "cron.mutateJobs",
        input: {
          storeKey,
          changes: prepareCronStoreChanges(previous, next),
          snapshot: { nowMs: now + 1 },
        },
      });
    },
  };
}

function scheduled(storeKey: string, current: CronJob) {
  return {
    jobId: current.id,
    configRevision: resolveCronJobConfigRevision(current),
    receiptId: createCronScheduledRunId(storeKey, current.id, now),
    scheduledSlotMs: now,
    mode: "scheduled" as const,
  };
}

it("deduplicates committed slots and drains persisted job order within worker capacity", async () => {
  const jobs = [
    job("z-first", { state: { nextRunAtMs: now, lastError: "previous run failed" } }),
    job("a-second"),
    job("m-third"),
  ];
  const queue = await store("capacity", jobs);
  const requests = jobs.map((current) => scheduled(queue.storeKey, current));
  const admitted = await queue.request([requests[2]!, requests[0]!, requests[0]!, requests[1]!]);
  expect(admitted.accepted).toHaveLength(3);
  expect(admitted.rejected).toEqual([
    { jobId: "z-first", receiptId: requests[0]!.receiptId, reason: "already-requested" },
  ]);
  expect((await queue.request([requests[0]!])).rejected).toEqual([
    { jobId: "z-first", receiptId: requests[0]!.receiptId, reason: "already-requested" },
  ]);
  const first = await queue.drain();
  expect(first.launches.map((entry) => entry.job.id)).toEqual(["z-first"]);
  expect(first.launches[0]?.job.state.lastError).toBe("previous run failed");
  expect((await queue.drain()).launches).toEqual([]);
  const persisted = await queue.read();
  expect(
    persisted.jobs.map((entry) => [entry.id, entry.state.queuedAtMs, entry.state.runningAtMs]),
  ).toEqual([
    ["z-first", undefined, now + 1],
    ["a-second", now, undefined],
    ["m-third", now, undefined],
  ]);
  await queue.cancel([first.launches[0]!.runReceipt.receiptId], "superseded");
  expect(await readCronRunRecords(queue.storeKey, "z-first")).toEqual([]);
  expect((await queue.drain()).launches.map((entry) => entry.job.id)).toEqual(["a-second"]);
});

it("uses edited payloads while queued and records a disabled request under its public acknowledgement ID", async () => {
  const original = job("edited");
  const queue = await store("edit", [original]);
  const request = scheduled(queue.storeKey, original);
  await queue.request([request]);
  await queue.edit((next) => {
    next.jobs[0]!.payload = { kind: "command", argv: ["echo", "new payload"] };
  });
  expect((await queue.drain()).launches[0]?.job.payload).toEqual({
    kind: "command",
    argv: ["echo", "new payload"],
  });

  const cancelJob = job("disabled");
  const cancelled = await store("disable", [cancelJob]);
  const manual = {
    jobId: cancelJob.id,
    receiptId: "cron:request:disabled",
    requestRunId: "public-ack",
    mode: "if-enabled" as const,
    configRevision: resolveCronJobConfigRevision(cancelJob),
  };
  await cancelled.request([manual]);
  await cancelled.edit((next) => {
    next.jobs[0]!.enabled = false;
  });
  const drained = await cancelled.drain([manual]);
  expect(drained.launches).toEqual([]);
  expect(drained.skipped.map((entry) => entry.runReceipt.receiptId)).toEqual([manual.receiptId]);
  expect((await cancelled.read()).jobs[0]?.state.queuedAtMs).toBeUndefined();
  const page = projectCronRunHistoryPage(await readCronRunRecords(cancelled.storeKey), {
    storeKey: cancelled.storeKey,
    runId: "public-ack",
  });
  expect(page.entries).toMatchObject([
    {
      status: "skipped",
      runId: "public-ack",
      error: "cron: queued job schedule changed or was disabled",
    },
  ]);
});

it("holds scheduled requests while paused and activates an explicit request behind them", async () => {
  const jobs = [job("timed-paused"), job("manual-paused")];
  const queue = await store("paused", jobs);
  const timed = scheduled(queue.storeKey, jobs[0]!);
  const manual = {
    jobId: jobs[1]!.id,
    receiptId: "cron-request.paused",
    mode: "force" as const,
    configRevision: resolveCronJobConfigRevision(jobs[1]!),
  };
  await queue.request([timed, manual]);
  const paused = await queue.drain([manual], 1, true);
  expect(paused.launches.map((entry) => entry.job.id)).toEqual(["manual-paused"]);
  expect(paused.skipped).toEqual([]);
  expect((await queue.read()).jobs[0]?.state.queuedAtMs).toBe(now);
  await queue.cancel([manual.receiptId], "superseded");
  expect((await queue.drain()).launches.map((entry) => entry.job.id)).toEqual(["timed-paused"]);
});

it("launches explicit force on a disabled job and retains a consumed exit event through rearming", async () => {
  const disabled = job("force", { enabled: false });
  const forced = await store("force", [disabled]);
  const force = {
    jobId: disabled.id,
    receiptId: "cron:request:force",
    mode: "force" as const,
    configRevision: resolveCronJobConfigRevision(disabled),
    preserveSchedule: true,
  };
  expect((await forced.request([force])).accepted).toHaveLength(1);
  expect((await forced.drain([force])).launches[0]?.job.enabled).toBe(false);

  const onExit = job("exit", {
    schedule: { kind: "on-exit", command: "synthetic-watch" },
    state: {},
  });
  const exit = await store("exit", [onExit]);
  const event = {
    jobId: onExit.id,
    receiptId: "cron:request:exit",
    mode: "on-exit" as const,
    onExitSchedule: { kind: "on-exit" as const, command: "synthetic-watch" },
    configRevision: resolveCronJobConfigRevision(onExit),
  };
  expect((await exit.request([event])).accepted[0]?.job.enabled).toBe(false);
  await exit.edit((next) => {
    next.jobs[0]!.enabled = true;
  });
  const result = await exit.drain([event]);
  expect(result.skipped).toEqual([]);
  expect(result.launches.map((entry) => entry.job.id)).toEqual(["exit"]);
});

it("recovers a timed request without replaying active work or reconstructing a lost manual payload", async () => {
  const timedJob = job("recover", { schedule: { kind: "at", at: new Date(now).toISOString() } });
  const queue = await store("recover", [timedJob]);
  const requested = (await queue.request([scheduled(queue.storeKey, timedJob)])).accepted[0]!;
  const repair = (entry: typeof requested, queuedAtMs?: number, runningAtMs?: number) =>
    executeOpenClawStateWorker(context, {
      type: "cron.repairRun",
      input: {
        storeKey: queue.storeKey,
        mode: "startup",
        proposal: {
          jobId: entry.job.id,
          queuedAtMs,
          runningAtMs,
          runningReceiptId: runningAtMs === undefined ? undefined : entry.runReceipt.receiptId,
          receipt: entry.runReceipt,
        },
        snapshot: { nowMs: now + 2, proposedReceiptIsStale: true },
      },
    });
  expect(await repair(requested, now)).toMatchObject({ outcome: { result: { kind: "repaired" } } });
  const active = (await queue.drain()).launches[0]!;
  expect(active.runReceipt.receiptId).toBe(requested.runReceipt.receiptId);
  expect(await repair(active, undefined, now + 1)).toMatchObject({
    outcome: { result: { kind: "repaired" } },
  });
  expect((await queue.drain()).launches).toEqual([]);
  const interrupted = (await queue.read()).jobs[0]!;
  expect(interrupted.state.lastRunStatus).toBe("error");
  expect(interrupted.state.runningAtMs).toBeUndefined();
  expect(interrupted.enabled).toBe(false);

  const manualJob = job("legacy");
  const legacy = await store("legacy", [manualJob]);
  const manual = {
    jobId: manualJob.id,
    receiptId: "old-random-receipt-id",
    mode: "force" as const,
    configRevision: resolveCronJobConfigRevision(manualJob),
  };
  await legacy.request([manual]);
  const lost = await legacy.drain();
  expect(lost.launches).toEqual([]);
  expect(lost.skipped).toMatchObject([
    {
      error: "cron: queued request lost its launch context",
      runReceipt: { receiptId: manual.receiptId },
    },
  ]);
  expect((await legacy.read()).jobs[0]?.state.queuedAtMs).toBeUndefined();
  const history = projectCronRunHistoryPage(await readCronRunRecords(legacy.storeKey), {
    storeKey: legacy.storeKey,
  });
  expect(history.entries).toMatchObject([
    { status: "skipped", error: "cron: queued request lost its launch context" },
  ]);
});

it.each(["request", "cancellation"] as const)(
  "recovers a committed %s after losing its worker reply without replay",
  async (phase) => {
    const current = job(`lost-${phase}`);
    const queue = await store(`lost-${phase}`, [current]);
    const request = scheduled(queue.storeKey, current);
    if (phase === "cancellation") {
      await queue.request([request]);
    }
    const reply = loseFirstCronMutationReply(
      phase === "request" ? "cron.requestRuns" : "cron.cancelRequests",
    );
    try {
      await expect(
        phase === "request" ? queue.request([request]) : queue.cancel([request.receiptId]),
      ).rejects.toBeInstanceOf(Error);
      await reply.waitForExit();
      expect(reply.wasDropped()).toBe(true);
      expect(reply.attempts).toEqual([
        phase === "request" ? "cron.requestRuns" : "cron.cancelRequests",
      ]);
    } finally {
      await reply.close();
    }
    context = captureOpenClawStateWorkerContext();
    if (phase === "request") {
      expect((await queue.read()).jobs[0]?.state.queuedAtMs).toBe(now);
      const resumed = await queue.drain();
      expect(resumed.launches.map((entry) => entry.runReceipt.receiptId)).toEqual([
        request.receiptId,
      ]);
      expect((await queue.request([request])).rejected[0]?.reason).toBe("already-requested");
    } else {
      expect((await queue.read()).jobs[0]?.state.queuedAtMs).toBeUndefined();
      expect((await queue.drain()).launches).toEqual([]);
      const history = projectCronRunHistoryPage(await readCronRunRecords(queue.storeKey), {
        storeKey: queue.storeKey,
      });
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]?.status).toBe("skipped");
    }
  },
);

it("cancels a removed queued job and rejects a plan made before its definition changed", async () => {
  const current = job("removed");
  const queue = await store("removed", [current]);
  const request = scheduled(queue.storeKey, current);
  await queue.request([request]);
  await queue.edit((next) => {
    next.jobs = [];
  });
  expect((await queue.drain([request])).skipped[0]?.runReceipt.receiptId).toBe(request.receiptId);
  expect((await queue.drain()).launches).toEqual([]);
  const changed = job("changed");
  const stale = await store("stale-plan", [changed]);
  await stale.edit((next) => {
    next.jobs[0]!.enabled = false;
  });
  expect((await stale.request([scheduled(stale.storeKey, changed)])).rejected).toEqual([
    {
      jobId: changed.id,
      receiptId: createCronScheduledRunId(stale.storeKey, changed.id, now),
      reason: "job-ineligible",
    },
  ]);
});
