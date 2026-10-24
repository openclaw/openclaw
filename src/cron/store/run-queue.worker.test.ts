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
import type { CronJob } from "../types.js";
import { readCronRunHistoryCandidates } from "./read-only.js";
import {
  queueJob,
  queueStore,
  requestFor,
  requestForJob,
  scheduled as scheduledAt,
  type QueueRequest,
} from "./run-queue.test-support.js";
import type { CronQueuedRun } from "./run-queue.types.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";

const now = 1_800_000_000_000;
let fixture: OpenClawTestState;
let context: OpenClawStateWorkerContext;
const jobIds = (runs: CronQueuedRun[]) => runs.map(({ job: entry }) => entry.id);
const runIds = (runs: { runReceipt: CronRunReceiptHandle }[]) =>
  runs.map(({ runReceipt }) => runReceipt.receiptId);
const rejected = (request: QueueRequest, reason = "already-requested") => [
  { jobId: request.jobId, receiptId: request.receiptId, reason },
];

beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "cron-worker-queue" });
  context = captureOpenClawStateWorkerContext();
  await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
});

afterAll(async () => {
  await fixture?.cleanup();
});

const job = (id: string, overrides?: Partial<CronJob>) => queueJob(id, now, overrides);
const store = (label: string, jobs: CronJob[]) =>
  queueStore(fixture.statePath("cron", `${label}.json`), jobs, now, () => context);
const scheduled = (storeKey: string, current: CronJob) => scheduledAt(storeKey, current, now);
async function scheduledQueue(id: string, overrides?: Partial<CronJob>) {
  const current = job(id, overrides);
  const queue = await store(id, [current]);
  return { current, queue, request: scheduled(queue.storeKey, current) };
}

it("keeps the first execution link across binding retries without changing the run claim", async () => {
  const { queue, request } = await scheduledQueue("execution-link");
  await queue.request([request]);
  const activated = await queue.drain();
  expect(activated.launches).toHaveLength(1);
  const receipt = activated.launches[0]!.runReceipt;
  const bind = (contextId: string, executionId: string) =>
    executeOpenClawStateWorker(context, {
      type: "cron.bindReceiptExecution",
      input: { receiptId: receipt.receiptId, binding: { contextId, executionId } },
    });

  expect(await bind("original-context", "original-execution")).toBe(true);
  expect(await bind("replacement-context", "replacement-execution")).toBe(false);
  expect(await bind("original-context", "original-execution")).toBe(true);
  expect(await queue.readReceipt(receipt)).toEqual(receipt);
  await queue.cancel([receipt.receiptId], "superseded");
});

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
  expect(admitted.rejected).toEqual(rejected(requests[0]!));
  expect((await queue.request([requests[0]!])).rejected).toEqual(rejected(requests[0]!));
  const first = await queue.drain();
  expect(jobIds(first.launches)).toEqual(["z-first"]);
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
  expect((await readCronRunHistoryCandidates(queue.storeKey, "z-first")).records).toEqual([]);
  expect(jobIds((await queue.drain()).launches)).toEqual(["a-second"]);
});

it("returns durable receipt handles across queued edits and records disabled requests under their public ID", async () => {
  const { current: original, queue, request } = await scheduledQueue("edited");
  const claimed = (await queue.request([request])).accepted[0]!;
  expect(await queue.readReceipt(claimed.runReceipt)).toEqual(claimed.runReceipt);
  const payload = { kind: "command" as const, argv: ["echo", "new payload"] };
  const edited = await queue.update(original.id, { payload, agentId: "edited-agent" });
  const editedJobs = "outcome" in edited ? edited.outcome.store.jobs : undefined;
  expect(editedJobs).toMatchObject([
    { id: original.id, agentId: "edited-agent", payload, state: { queuedAtMs: now } },
  ]);
  expect(edited).toMatchObject({ outcome: { store: await queue.read() } });
  const activated = (await queue.drain()).launches[0]!;
  expect(activated.job.payload).toEqual(payload);
  expect(activated.runReceipt).toEqual({
    ...claimed.runReceipt,
    agentId: "edited-agent",
    configRevision: resolveCronJobConfigRevision(activated.job),
    startedAtMs: now + 1,
  });
  expect(await queue.readReceipt(activated.runReceipt)).toEqual(activated.runReceipt);
  expect((await queue.request([request])).rejected).toEqual(rejected(request));

  const cancelJob = job("disabled");
  const cancelled = await store("disable", [cancelJob]);
  const manual = requestFor(cancelJob, {
    receiptId: "cron:request:disabled",
    requestRunId: "public-ack",
    mode: "if-enabled" as const,
  });
  await cancelled.request([manual]);
  const disabled = await cancelled.update(cancelJob.id, { enabled: false });
  expect(disabled).toMatchObject({ outcome: { store: await cancelled.read() } });
  const disabledJob = "outcome" in disabled ? disabled.outcome.store.jobs[0] : undefined;
  expect(disabledJob?.enabled).toBe(false);
  expect(disabledJob?.state.queuedAtMs).toBeUndefined();
  const drained = await cancelled.drain([manual]);
  expect(drained.launches).toEqual([]);
  expect(runIds(drained.skipped)).toEqual([manual.receiptId]);
  expect((await cancelled.read()).jobs[0]?.state.queuedAtMs).toBeUndefined();
  const page = await cancelled.history("public-ack");
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
  const manual = requestFor(jobs[1]!, {
    receiptId: "cron-request.paused",
    mode: "force" as const,
  });
  await queue.request([timed, manual]);
  const paused = await queue.drain([manual], 1, true);
  expect(jobIds(paused.launches)).toEqual(["manual-paused"]);
  expect(paused.skipped).toEqual([]);
  expect((await queue.read()).jobs[0]?.state.queuedAtMs).toBe(now);
  await queue.cancel([manual.receiptId], "superseded");
  expect(jobIds((await queue.drain()).launches)).toEqual(["timed-paused"]);
});

it("launches explicit force on a disabled job and retains a consumed exit event through rearming", async () => {
  const disabled = job("force", { enabled: false });
  const forced = await store("force", [disabled]);
  const force = requestFor(disabled, {
    receiptId: "cron:request:force",
    mode: "force" as const,
    preserveSchedule: true,
  });
  expect((await forced.request([force])).accepted).toHaveLength(1);
  expect((await forced.drain([force])).launches[0]?.job.enabled).toBe(false);

  const onExit = job("exit", {
    schedule: { kind: "on-exit", command: "synthetic-watch" },
    state: {},
  });
  const exit = await store("exit", [onExit]);
  const event = requestForJob(exit.storeKey, onExit, now);
  expect((await exit.request([event])).accepted[0]?.job.enabled).toBe(false);
  await exit.update(onExit.id, { enabled: true });
  const result = await exit.drain([event]);
  expect(result.skipped).toEqual([]);
  expect(jobIds(result.launches)).toEqual(["exit"]);
});

it("recovers a timed request without replaying active work or reconstructing a lost manual payload", async () => {
  const { queue, request } = await scheduledQueue("recover", {
    schedule: { kind: "at", at: new Date(now).toISOString() },
  });
  const requested = (await queue.request([request])).accepted[0]!;
  expect((await queue.recover()).jobs[0]?.state.queuedAtMs).toBe(now);
  const active = (await queue.drain()).launches[0]!;
  expect(active.runReceipt.receiptId).toBe(requested.runReceipt.receiptId);
  expect((await queue.recover()).interruptedRuns).toHaveLength(1);
  expect((await queue.drain()).launches).toEqual([]);
  const interrupted = (await queue.read()).jobs[0]!;
  expect(interrupted).toMatchObject({
    enabled: false,
    state: { lastRunStatus: "error" },
  });
  expect(interrupted.state.runningAtMs).toBeUndefined();

  const manualJob = job("legacy");
  const legacy = await store("legacy", [manualJob]);
  const manual = requestFor(manualJob, {
    receiptId: "old-random-receipt-id",
    mode: "force" as const,
  });
  await legacy.request([manual]);
  const held = await legacy.drain();
  expect(held).toEqual({ launches: [], preparing: [], skipped: [] });
  expect((await legacy.read()).jobs[0]?.state.queuedAtMs).toBe(now);
  await legacy.recover();
  expect((await legacy.read()).jobs[0]?.state.queuedAtMs).toBeUndefined();
  expect((await legacy.drain()).launches).toEqual([]);
  const history = await legacy.history();
  expect(history.entries).toMatchObject([
    { status: "skipped", error: "cron: queued request lost its launch context" },
  ]);
});

it.each(["request", "cancellation"] as const)(
  "recovers a committed %s after losing its worker reply without replay",
  async (phase) => {
    const { queue, request } = await scheduledQueue(`lost-${phase}`);
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
      expect(runIds(resumed.launches)).toEqual([request.receiptId]);
      expect((await queue.request([request])).rejected[0]?.reason).toBe("already-requested");
    } else {
      expect((await queue.read()).jobs[0]?.state.queuedAtMs).toBeUndefined();
      expect((await queue.drain()).launches).toEqual([]);
      const history = await queue.history();
      expect(history.entries).toMatchObject([{ status: "skipped" }]);
    }
  },
);

it("cancels a removed queued job and rejects a plan made before its definition changed", async () => {
  const { current, queue, request } = await scheduledQueue("removed");
  await queue.request([request]);
  await queue.remove(current.id);
  expect((await queue.drain([request])).skipped[0]?.runReceipt.receiptId).toBe(request.receiptId);
  expect((await queue.drain()).launches).toEqual([]);
  const { current: changed, queue: stale, request: staleRequest } = await scheduledQueue("changed");
  await stale.update(changed.id, { enabled: false });
  expect((await stale.request([staleRequest])).rejected).toEqual(
    rejected(staleRequest, "job-ineligible"),
  );
});
