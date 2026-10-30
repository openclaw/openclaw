import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../test/helpers/cron/runtime-mutation.js";
import { createDueIsolatedJob } from "../../test/helpers/cron/service-regression-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  createAgentDatabaseInspectionRefusal,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import type { OpenClawDatabaseSchemaPreflight } from "../state/openclaw-database-preflight.types.js";
import * as stateRead from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { cronTestDeps } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import {
  createFinishedBarrier,
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import {
  commitCronRunRequests,
  drainCronRunQueue,
  stopCronRunQueue,
  waitForCronRunQueue,
} from "./service/run-queue.js";
import { runCronSchedulerMaintenance } from "./service/scheduler-maintenance.js";
import { createCronServiceState, type CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import * as cronStore from "./store.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { createCronScheduledRunId } from "./store/run-request-id.js";
import { cronStreamScheduleKey } from "./stream-schedule.js";
import type { CronJob } from "./types.js";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-run-queue-",
  fakeTimers: false,
});

function serviceDeps(storePath: string, overrides: Partial<CronServiceDeps> = {}): CronServiceDeps {
  return cronTestDeps({
    nowMs: () => NOW,
    storePath,
    defaultAgentId: "main",
    log: logger,
    enqueueSystemEvent() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
    ...overrides,
  });
}

const service = (storePath: string, overrides: Partial<CronServiceDeps> = {}) =>
  createCronServiceWithStateForTest(serviceDeps(storePath, overrides));
const successfulCommand = () => vi.fn(async () => ({ status: "ok" as const }));
const ready = { incompatible: [], indeterminate: [] };

async function storeJobs(jobs: CronJob[]) {
  const { storePath } = await makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs });
  return storePath;
}

async function stopServices(...services: CronService[]) {
  services.forEach((cron) => cron.stop());
  await Promise.all(services.map((cron) => cron.waitForIdle()));
}

function gatedCommand() {
  const entered = createDeferred();
  const release = createDeferred();
  const runCommandJob = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return { status: "ok" as const };
  });
  return { entered, release, runCommandJob };
}

function readReceipt(receiptId: string) {
  return runOpenClawStateWriteTransaction(({ db }) =>
    db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?").get(receiptId),
  );
}

async function requestStoredRun(
  storePath: string,
  job: CronJob,
  receiptId: string,
  scheduled = false,
) {
  const context = captureOpenClawStateWorkerContext();
  await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
  const requested = await executeOpenClawStateWorker(context, {
    type: "cron.requestRuns",
    input: {
      storeKey: storePath,
      nowMs: NOW,
      ...(scheduled ? { defaultAgentId: "main" } : {}),
      requests: [
        {
          jobId: job.id,
          receiptId,
          configRevision: resolveCronJobConfigRevision(job),
          mode: scheduled ? "scheduled" : "force",
          ...(scheduled ? { scheduledSlotMs: NOW, scheduleOwnershipAtMs: NOW } : {}),
        },
      ],
    },
  });
  expect(requested.accepted).toHaveLength(1);
  return context;
}

type StartupAdmission = Parameters<Parameters<typeof withAgentDatabaseStartupAdmission>[0]>[0];
function deferAdmission(
  admission: StartupAdmission,
  agentIds: string[],
  env: NodeJS.ProcessEnv = { ...process.env },
  isCurrent = () => true,
) {
  const inspections = agentIds.map(() => createDeferred<OpenClawDatabaseSchemaPreflight>());
  const refusals = admission.defer({
    env,
    reason: "synthetic cron startup admission",
    inspections: agentIds.map((agentId, index) => ({
      target: { agentId, path: openOpenClawAgentDatabase({ agentId, env }).path },
      result: inspections[index]!.promise,
    })),
  });
  recordAgentDatabaseAdmissions(refusals, { env, source: "startup" });
  const lifetime = admission.adopt();
  admission.activate({
    isCurrent,
    preparationReady: Promise.resolve(),
    openAgent: async () => {},
    migrateAgent: async () => {},
    publishAgent: async () => {},
  });
  return { refusals, lifetime, env, inspections, inspection: inspections[0]! };
}

function commandJob(id: string, nextRunAtMs = NOW + 60_000): CronJob {
  return {
    ...createDueIsolatedJob({ id, nowMs: NOW, nextRunAtMs }),
    agentId: "main",
    payload: { kind: "command", argv: ["synthetic", id] },
  };
}

it("finishes cron initialization while missed command jobs await their agents", async ({
  signal,
}) => {
  const jobs = ["never-ready", "later-ready"].map((agentId) =>
    Object.assign(commandJob(agentId, NOW - 1_000), { agentId }),
  );
  const storePath = await storeJobs(jobs);
  await withAgentDatabaseStartupAdmission(async (admission) => {
    const { lifetime, env, inspections } = deferAdmission(
      admission,
      jobs.map((job) => job.agentId),
    );
    const finished = createFinishedBarrier();
    const laterFinished = finished.waitForOk("later-ready");
    const runCommandJob = successfulCommand();
    const { cron, state } = service(storePath, { runCommandJob, onEvent: finished.onEvent });
    const receipts = () =>
      runOpenClawStateWriteTransaction(({ db }) =>
        db
          .prepare(
            "SELECT job_id, receipt_id, status FROM cron_run_receipts WHERE store_key = ? ORDER BY job_id",
          )
          .all(storePath),
      );
    const starting = cron.start();
    try {
      await withinTest(starting, signal);
      expect(runCommandJob).not.toHaveBeenCalled();
      expect((await loadCronStore(storePath)).jobs.map((job) => job.state)).toEqual([
        expect.objectContaining({ queuedAtMs: NOW }),
        expect.objectContaining({ queuedAtMs: NOW }),
      ]);
      const queuedReceipts = receipts();
      expect(queuedReceipts).toEqual([
        { job_id: "later-ready", receipt_id: expect.any(String), status: "running" },
        { job_id: "never-ready", receipt_id: expect.any(String), status: "running" },
      ]);

      inspections[1]!.resolve(ready);
      await withinTest(laterFinished, signal);
      await drainCronRunQueue(state);
      expect(runCommandJob).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ job: expect.objectContaining({ id: "later-ready" }) }),
      );
      expect(receipts()).toEqual([{ ...queuedReceipts[0], status: "ok" }, queuedReceipts[1]]);
      const neverReady = (await loadCronStore(storePath)).jobs.find(
        (job) => job.id === "never-ready",
      );
      expect(neverReady?.state.queuedAtMs).toBe(NOW);
      expect(neverReady?.state.runningAtMs).toBeUndefined();
    } finally {
      cron.stop();
      for (const inspection of inspections) {
        inspection.resolve(ready);
      }
      await Promise.all([starting, cron.waitForIdle(), lifetime.stop()]);
      recordAgentDatabaseAdmissions([], { env, source: "startup" });
    }
  });
});

it.for(["manual", "scheduled"] as const)(
  "keeps service-scoped preparing jobs queued while a healthy agent runs: %s",
  async (source, { signal }) => {
    const slowJobs = Array.from({ length: 8 }, (_, index) => ({
      ...commandJob(`slow-${index}`, NOW),
      agentId: "preparing",
    }));
    const healthyJob = commandJob("healthy", NOW);
    const storePath = await storeJobs([...slowJobs, healthyJob]);
    await withAgentDatabaseStartupAdmission(async (admission) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(path.dirname(storePath), "admission-state"),
      };
      const {
        refusals: refusal,
        lifetime,
        inspection,
      } = deferAdmission(admission, ["preparing"], env);
      const healthyStarted = createDeferred();
      const healthyRelease = createDeferred();
      const ran: string[] = [];
      const { cron, state } = service(storePath, {
        env,
        isAgentAvailable: (agentId) => !readAgentDatabaseAdmissionRefusal(agentId, { env }),
        runCommandJob: async ({ job }) => {
          ran.push(job.id);
          if (job.id === healthyJob.id) {
            healthyStarted.resolve();
            await healthyRelease.promise;
          }
          return { status: "ok" };
        },
      });
      try {
        const requests =
          source === "manual"
            ? await commitCronRunRequests(state, [...slowJobs, healthyJob], {
                source,
                mode: "force",
              })
            : [];
        const completed =
          source === "scheduled"
            ? onTimer(state)
            : drainCronRunQueue(state).then(async () => {
                await Promise.all(requests.map((request) => request.completion));
              });
        void completed.catch(() => {});
        if (source === "manual") {
          await drainCronRunQueue(state);
        } else {
          await withinTest(healthyStarted.promise, signal);
        }
        const queued = (await loadCronStore(storePath)).jobs;
        expect(
          queued
            .filter((job) => job.agentId === "preparing")
            .every(
              (job) => job.state.queuedAtMs !== undefined && job.state.runningAtMs === undefined,
            ),
        ).toBe(true);
        await withinTest(healthyStarted.promise, signal);
        expect(ran).toEqual([healthyJob.id]);
        // A different service can still be preparing the same agent id.
        recordAgentDatabaseAdmissions(
          refusal.map((entry) => createAgentDatabaseInspectionRefusal({ ...entry, pending: true })),
          { source: "startup" },
        );
        healthyRelease.resolve();
        inspection.resolve(ready);
        await withinTest(completed, signal);
        expect(ran).toEqual([healthyJob.id, ...slowJobs.map((job) => job.id)]);
      } finally {
        healthyRelease.resolve();
        inspection.resolve(ready);
        cron.stop();
        await Promise.all([cron.waitForIdle(), lifetime.stop()]);
        recordAgentDatabaseAdmissions([], { source: "startup" });
      }
    });
  },
);

it.for([
  "ready",
  "inspection-failed",
  "ownership-lost",
  "service-stopped",
  "gateway-stopped",
] as const)(
  "retains cron custody beyond the foreground admission budget: %s",
  async (outcome, { signal }) => {
    const job = { ...commandJob("slow-startup"), agentId: "preparing" };
    const storePath = await storeJobs([job]);
    await withAgentDatabaseStartupAdmission(async (admission) => {
      let ownsPreparation = true;
      const { lifetime, env, inspection } = deferAdmission(
        admission,
        [job.agentId],
        undefined,
        () => ownsPreparation,
      );
      const observed = createDeferred();
      const observer = admission.observation;
      const waitForPreparation = observer.waitForAgentPreparation.bind(observer);
      vi.spyOn(observer, "waitForAgentPreparation").mockImplementation((id, options) => {
        const waiting = waitForPreparation(id, options);
        observed.resolve();
        return waiting;
      });
      const runCommandJob = successfulCommand();
      const { cron, state } = service(storePath, { runCommandJob });
      try {
        const [request] = await commitCronRunRequests(state, [job], {
          source: "manual",
          mode: "force",
        });
        if (!request) {
          throw new Error("Expected the queued cron request");
        }
        const receiptStatus = () => readReceipt(request.runReceipt.receiptId);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await drainCronRunQueue(state);
        await withinTest(observed.promise, signal);
        // A foreground request expires, while the same startup owner keeps preparing.
        const foreground = waitForPreparation(job.agentId, { env, forWrite: true });
        const timedOut = expect(foreground).rejects.toThrow("still preparing");
        await vi.advanceTimersByTimeAsync(360_001);
        await timedOut;
        vi.useRealTimers();
        expect(receiptStatus()).toEqual({ status: "running" });
        const queued = (await loadCronStore(storePath)).jobs[0]?.state;
        expect(queued?.queuedAtMs).toBe(NOW);
        expect(queued?.runningAtMs).toBeUndefined();
        expect(runCommandJob).not.toHaveBeenCalled();

        if (outcome === "service-stopped" || outcome === "gateway-stopped") {
          if (outcome === "service-stopped") {
            cron.stop();
          } else {
            const stopped = lifetime.stop();
            inspection.resolve(ready);
            await stopped;
          }
          await withinTest(waitForCronRunQueue(state), signal);
          expect(await request.completion).toMatchObject({ ran: false, reason: "stopped" });
          expect(receiptStatus()).toEqual({ status: "running" });
          expect((await loadCronStore(storePath)).jobs[0]?.state.queuedAtMs).toBe(NOW);
          expect(runCommandJob).not.toHaveBeenCalled();
        } else {
          if (outcome === "inspection-failed") {
            inspection.reject(new Error("synthetic terminal inspection failure"));
          } else {
            ownsPreparation = outcome !== "ownership-lost";
            inspection.resolve(ready);
          }
          if (outcome === "ready") {
            await withinTest(request.completion, signal);
          } else {
            await expect(withinTest(request.completion, signal)).rejects.toThrow(
              outcome === "inspection-failed"
                ? "synthetic terminal inspection failure"
                : "Gateway no longer owns preparation",
            );
          }
          await withinTest(waitForCronRunQueue(state), signal);
          expect(receiptStatus()).toEqual({ status: outcome === "ready" ? "ok" : "skipped" });
          expect(runCommandJob).toHaveBeenCalledTimes(outcome === "ready" ? 1 : 0);
          expect((await loadCronStore(storePath)).jobs[0]?.state.queuedAtMs).toBeUndefined();
          await drainCronRunQueue(state);
          expect(runCommandJob).toHaveBeenCalledTimes(outcome === "ready" ? 1 : 0);
        }
      } finally {
        vi.useRealTimers();
        inspection.resolve(ready);
        cron.stop();
        await Promise.all([cron.waitForIdle(), lifetime.stop()]);
        recordAgentDatabaseAdmissions([], { env, source: "startup" });
      }
    });
  },
);

it.for(["complete", "cancel", "lost-result"] as const)(
  "handles a same-store on-exit predecessor without joining unrelated work: %s",
  async (outcome, { signal }) => {
    const schedule = { kind: "on-exit", command: "synthetic-exit" } as const;
    const job = { ...commandJob("exit-wait"), schedule };
    const unrelated = commandJob("unrelated-wait");
    const storePath = await storeJobs([job, unrelated]);
    const targetEntered = createDeferred();
    const unrelatedEntered = createDeferred();
    const releaseTarget = createDeferred();
    const releaseUnrelated = createDeferred();
    const accepted = createDeferred();
    let targetRuns = 0;
    const runCommandJob = vi.fn(async ({ job: current }: { job: CronJob }) => {
      if (current.id === unrelated.id) {
        unrelatedEntered.resolve();
        await releaseUnrelated.promise;
      } else if (++targetRuns === 1) {
        targetEntered.resolve();
        await releaseTarget.promise;
      }
      return { status: "ok" as const };
    });
    const createService = () => new CronService(serviceDeps(storePath, { runCommandJob }));
    const cron = createService();
    const sibling = createService();
    const controller = new AbortController();
    const pending: Array<Promise<unknown>> = [];
    let restoreFinalization: (() => void) | undefined;
    try {
      const first = cron.run(job.id, "force");
      void first.catch(() => {});
      const other = cron.run(unrelated.id, "force");
      pending.push(first, other);
      await withinTest(Promise.all([targetEntered.promise, unrelatedEntered.promise]), signal);
      if (outcome === "lost-result") {
        const execute = stateWorker.executeOpenClawStateWorker;
        const finalization = vi
          .spyOn(stateWorker, "executeOpenClawStateWorker")
          .mockImplementation((context, command) =>
            command.type === "cron.finalizeRuns"
              ? Promise.reject(new Error("synthetic terminal write failure"))
              : execute(context, command),
          );
        restoreFinalization = () => finalization.mockRestore();
      }
      const exit = sibling.runOnExit(job.id, {
        schedule,
        signal: controller.signal,
        commitGuard() {},
        onReserved: () => accepted.resolve(),
      });
      pending.push(exit);
      if (outcome === "cancel") {
        controller.abort();
        await expect(withinTest(exit, signal)).resolves.toMatchObject({
          ok: true,
          ran: false,
          reason: "stopped",
        });
        releaseTarget.resolve();
        await withinTest(first, signal);
        expect(targetRuns).toBe(1);
      } else if (outcome === "lost-result") {
        releaseTarget.resolve();
        await expect(withinTest(first, signal)).rejects.toThrow("synthetic terminal write failure");
        await expect(withinTest(exit, signal)).resolves.toMatchObject({
          ok: true,
          ran: false,
          reason: "already-running",
        });
        expect(targetRuns).toBe(1);
      } else {
        releaseTarget.resolve();
        await withinTest(accepted.promise, signal);
        await expect(withinTest(exit, signal)).resolves.toMatchObject({ ok: true, ran: true });
        expect(targetRuns).toBe(2);
      }
      expect((await cron.readJob(unrelated.id))?.state.runningAtMs).toBeDefined();
    } finally {
      controller.abort();
      restoreFinalization?.();
      releaseTarget.resolve();
      releaseUnrelated.resolve();
      await Promise.allSettled(pending);
      await stopServices(cron, sibling);
    }
  },
);

it("keeps owned running work out of recovery and queue database polling", async ({ signal }) => {
  const job = commandJob("owned-running");
  const storePath = await storeJobs([job]);
  const { entered, release, runCommandJob } = gatedCommand();
  const { cron, state } = service(storePath, { runCommandJob });
  let completion: Promise<unknown> | undefined;
  let restoreLoads: (() => void) | undefined;
  try {
    await cron.start();
    const loads = vi.spyOn(cronStore, "loadCronJobsStoreWithConfigJobs");
    restoreLoads = () => loads.mockRestore();
    completion = cron.run(job.id, "force");
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, completion, "owned run did not start"),
      signal,
    );
    // Manual admission and queue activation reuse the loaded store and committed postimages.
    expect(loads).not.toHaveBeenCalled();
    await cron.start();
    const running = await cron.readJob(job.id);
    expect(running).toMatchObject({
      state: { runningAtMs: NOW, runningReceiptId: expect.any(String) },
    });
    expect(running?.state.lastError).toBeUndefined();
    expect(loads).not.toHaveBeenCalled();
    loads.mockRestore();
    // Consume the queue's committed publication once, then the loaded owner is current.
    await runCronSchedulerMaintenance(state);
    await drainCronRunQueue(state);
    const reads = vi.spyOn(stateRead, "executeExistingOpenClawStateRead");
    const writes = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
    try {
      await runCronSchedulerMaintenance(state);
      await drainCronRunQueue(state);
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      writes.mockRestore();
    }
  } finally {
    restoreLoads?.();
    release.resolve();
    await completion;
    await stopServices(cron);
  }
});

it("joins a running job before restarting after scheduler cleanup fails", async ({ signal }) => {
  const job = commandJob("restart-after-cleanup");
  const storePath = await storeJobs([job]);
  const { entered, release, runCommandJob } = gatedCommand();
  const cleanupFailed = createDeferred();
  const { cron, state } = service(storePath, { runCommandJob });
  const pending: Array<Promise<unknown>> = [];
  let restoreStop: (() => void) | undefined;
  try {
    await cron.start();
    const running = cron.run(job.id, "force");
    pending.push(running);
    await withinTest(entered.promise, signal);
    const stopScope = state.schedulerScope.stop.bind(state.schedulerScope);
    const stop = vi.spyOn(state.schedulerScope, "stop").mockImplementationOnce(async () => {
      await stopScope();
      cleanupFailed.resolve();
      throw new Error("synthetic scheduler cleanup failure");
    });
    restoreStop = () => stop.mockRestore();
    cron.stop();
    const restarting = cron.start();
    pending.push(restarting);
    void restarting.catch(() => {});
    await withinTest(cleanupFailed.promise, signal);
    expect(state.stopped).toBe(true);
    release.resolve();
    await withinTest(Promise.all([running, restarting]), signal);
    expect(await cron.readJob(job.id)).toMatchObject({ state: { lastRunStatus: "ok" } });
    await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    expect(runCommandJob).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    restoreStop?.();
    await Promise.allSettled(pending);
    await stopServices(cron);
  }
});

it("shares capacity across sibling services for timer, manual, stream, and consumed exit requests", async ({
  signal,
}) => {
  const clock = createGatewaySchedulerClock(NOW);
  const release = createDeferred();
  const capacityFilled = createDeferred();
  const exitAccepted = createDeferred();
  const timerRequested = createDeferred();
  const blockers = Array.from({ length: 8 }, (_, index) => commandJob(`blocker-${index}`));
  const manual = commandJob("queued-manual");
  const disabled = commandJob("queued-disabled");
  const removed = commandJob("queued-removed");
  const timed = commandJob("queued-timer", NOW + 10_000);
  const exitSchedule = { kind: "on-exit" as const, command: "synthetic-watch" };
  const exit: CronJob = { ...commandJob("queued-exit"), schedule: exitSchedule, state: {} };
  const streamSchedule = { kind: "stream" as const, command: ["synthetic-stream"] };
  const stream: CronJob = {
    ...commandJob("queued-stream"),
    schedule: streamSchedule,
    payload: { kind: "agentTurn", message: "configured stream payload" },
    state: { streamSourceIdentity: "synthetic-source" },
  };
  const storePath = await storeJobs([...blockers, manual, disabled, removed, timed, stream, exit]);
  let active = 0;
  let peakActive = 0;
  let blockersStarted = 0;
  const executed: CronJob[] = [];
  const runCommandJob = vi.fn(async ({ job }: { job: CronJob }) => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    try {
      if (job.id.startsWith("blocker-")) {
        blockersStarted += 1;
        if (blockersStarted === 8) {
          capacityFilled.resolve();
        }
        await release.promise;
      } else {
        executed.push(structuredClone(job));
      }
      return { status: "ok" as const };
    } finally {
      active -= 1;
    }
  });
  const runIsolatedAgentJob = successfulCommand();
  const createService = () =>
    service(storePath, {
      scheduler: createTestGatewayScheduler(clock.clock),
      nowMs: clock.clock.now,
      runCommandJob,
      runIsolatedAgentJob,
    });
  const { cron, state } = createService();
  const { cron: sibling } = createService();
  sibling.pauseScheduling();
  const pending: Array<Promise<unknown>> = [];
  const stopObserving = observeCronJobCommits(timed.id, (runtime) => {
    if (runtime.queuedAtMs !== undefined) {
      timerRequested.resolve();
    }
  });
  try {
    await cron.start();
    pending.push(...blockers.map((job) => cron.run(job.id, "force")));
    await withinTest(capacityFilled.promise, signal);

    await clock.advanceBy(10_000);
    const tick = onTimer(state);
    pending.push(tick);
    await withinTest(
      awaitGateBeforeSettlement(timerRequested.promise, tick, "timer did not queue its due job"),
      signal,
    );
    const manualAck = await cron.enqueueRun(manual.id, "force");
    expect(manualAck).toMatchObject({ ok: true, enqueued: true });
    for (const [job, remove] of [
      [disabled, false],
      [removed, true],
    ] as const) {
      const ack = await sibling.enqueueRun(job.id, "force");
      if (!ack.ok || !("runId" in ack)) {
        throw new Error("Expected a queued request before cancellation");
      }
      if (remove) {
        await cron.remove(job.id);
      } else {
        await cron.update(job.id, { enabled: false });
      }
      expect(await sibling.waitForManualRun(ack.runId, 60_000, signal)).toBe(true);
      expect(active).toBe(8);
      expect(executed).toEqual([]);
    }
    const streamRun = sibling.run(stream.id, "force", {
      payload: { kind: "agentTurn", message: "accepted stream payload" },
      streamBatch: "line one\nline two",
      streamScheduleKey: cronStreamScheduleKey(streamSchedule),
      streamSourceIdentity: "synthetic-source",
    });
    pending.push(streamRun);
    const exitRun = sibling.runOnExit(exit.id, {
      schedule: exitSchedule,
      signal,
      commitGuard() {},
      onReserved: () => exitAccepted.resolve(),
      payload: () => ({ kind: "command", argv: ["synthetic", "accepted exit"] }),
    });
    pending.push(exitRun);
    await withinTest(
      awaitGateBeforeSettlement(exitAccepted.promise, exitRun, "exit was not accepted"),
      signal,
    );

    const queued = (await loadCronStore(storePath)).jobs;
    for (const job of [manual, timed, stream, exit]) {
      expect(
        queued.find((candidate) => candidate.id === job.id)?.state.queuedAtMs,
        `${job.id}: queued run remains behind shared capacity`,
      ).toEqual(expect.any(Number));
    }
    expect(queued.find((job) => job.id === exit.id)?.enabled).toBe(false);
    expect(executed).toEqual([]);
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();

    release.resolve();
    await withinTest(Promise.all(pending), signal);
    if (!manualAck.ok || !("runId" in manualAck)) {
      throw new Error("Expected the accepted manual request ID");
    }
    expect(await cron.waitForManualRun(manualAck.runId, 60_000, signal)).toBe(true);
    expect(peakActive).toBe(8);
    expect(executed.map((job) => job.id).toSorted()).toEqual(
      [exit.id, manual.id, timed.id].toSorted(),
    );
    expect(executed.find((job) => job.id === exit.id)).toMatchObject({
      enabled: false,
      payload: { kind: "command", argv: ["synthetic", "accepted exit"] },
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "accepted stream payload\n\nline one\nline two" }),
    );
    const persistedExit = (await loadCronStore(storePath)).jobs.find((job) => job.id === exit.id);
    expect(persistedExit).toMatchObject({ enabled: false, state: { lastRunStatus: "ok" } });
  } finally {
    release.resolve();
    stopObserving();
    await Promise.allSettled(pending);
    await stopServices(cron, sibling);
  }
});

it("retires a stale markerless receipt at startup so the job can run again", async () => {
  const job = commandJob("markerless-receipt");
  const storePath = await storeJobs([job]);
  const receiptId = "cron:request:markerless-receipt";
  const context = await requestStoredRun(storePath, job, receiptId);
  const active = await executeOpenClawStateWorker(context, {
    type: "cron.drainQueue",
    input: {
      storeKey: storePath,
      nowMs: NOW,
      maxConcurrentRuns: 1,
      requests: [{ receiptId, mode: "force" }],
    },
  });
  expect(active.launches).toHaveLength(1);
  // Model a crash after job finalization but before the deferred receipt finish.
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      "UPDATE cron_jobs SET state_json = json_remove(state_json, '$.runningAtMs', '$.runningReceiptId') WHERE store_key = ? AND job_id = ?",
    ).run(storePath, job.id);
  });
  const readOldReceipt = () =>
    runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT receipt_id, status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receiptId),
    );
  expect(readOldReceipt()).toEqual({ receipt_id: receiptId, status: "running" });
  const runCommandJob = successfulCommand();
  const { cron } = service(storePath, { runCommandJob });
  try {
    await cron.start();
    expect(readOldReceipt()).toEqual({ receipt_id: receiptId, status: "interrupted" });
    expect(runCommandJob).not.toHaveBeenCalled();
    expect(await cron.run(job.id, "force")).toEqual({ ok: true, ran: true });
    expect(runCommandJob).toHaveBeenCalledOnce();
    expect(readOldReceipt()).toEqual({ receipt_id: receiptId, status: "interrupted" });
    expect((await loadCronStore(storePath)).jobs[0]?.state.lastRunStatus).toBe("ok");
  } finally {
    await stopServices(cron);
  }
});

it("contains recovered scheduled launch failures without an unhandled rejection", async () => {
  const job = commandJob("recovered-launch-failure", NOW);
  const storePath = await storeJobs([job]);
  const receiptId = createCronScheduledRunId(storePath, job.id, NOW);
  await requestStoredRun(storePath, job, receiptId, true);
  const failure = new Error("scheduler owner is retired");
  const scheduler = createTestGatewayScheduler();
  const state = createCronServiceState(
    serviceDeps(storePath, {
      scheduler,
      runSchedulerOwned: async () => {
        throw failure;
      },
    }),
  );
  // Durable requests survive restart; this new owner has no caller completion to observe.
  state.store = await loadCronStore(storePath);
  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", observe);
  try {
    await drainCronRunQueue(state);
    await waitForCronRunQueue(state);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(unhandled).toEqual([]);
    const persisted = (await loadCronStore(storePath)).jobs[0];
    expect(persisted?.state.queuedAtMs).toBeUndefined();
    expect(persisted?.state.runningAtMs).toBeUndefined();
  } finally {
    process.off("unhandledRejection", observe);
    state.stopped = true;
    await stopCronRunQueue(state);
    await waitForCronRunQueue(state);
    await scheduler.stop();
  }
});
