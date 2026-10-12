import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { markCronJobActive } from "../active-jobs.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import { cronScriptFailureMetadata } from "../script-failure.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob, CronRunOutcome } from "../types.js";
import {
  createAlertJob,
  createAlertState,
  finalizeAlertOutcome,
  type SendCronFailureAlert,
} from "./failure-alerts.test-support.js";
import { applyJobResultAndDrainNotifications } from "./notification.test-helpers.js";
import { stop as stopCronService } from "./ops-lifecycle.js";
import { restoreFinalizedStartupRun } from "./startup-run-repair.js";
import type { DeferredCronNotifications } from "./state.js";
import { authorCronRunCompletion } from "./timer-job-runner.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";
import { applyTriggerNoFireResult } from "./timer-outcomes.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-failure-alert-outcome-" });

describe("cron failure alert outcome write-back", () => {
  const dueAt = Date.parse("2026-08-01T15:00:00.000Z");
  const endedAt = dueAt + 10;

  async function runFailure(params: { id: string; sendCronFailureAlert: SendCronFailureAlert }) {
    const store = fixtures.makeStorePath();
    const job = createAlertJob({ id: params.id, dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => endedAt,
      sendCronFailureAlert: params.sendCronFailureAlert,
    });
    await finalizeAlertOutcome({
      state,
      job,
      status: "error",
      error: "provider unavailable",
      startedAt: dueAt,
      endedAt,
    });
    return { store, state, job };
  }

  it.each([
    { name: "the original owner", initialOwner: "alpha" },
    { name: "an unresolved owner", initialOwner: undefined },
  ])(
    "keeps $name for delayed failure fallback after the default changes",
    async ({ initialOwner }) => {
      const store = fixtures.makeStorePath();
      const job = createAlertJob({ id: "alert-delayed-fallback-routing", dueAt });
      job.wakeMode = "now";
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });
      const delivery = createDeferred();
      const send = vi.fn<SendCronFailureAlert>(async (params) => {
        await delivery.promise;
        await params.onDeliverySettled({ delivered: false, status: "not-delivered" });
      });
      let currentDefault = initialOwner;
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => endedAt,
        sendCronFailureAlert: send,
      });
      state.deps.defaultAgentId = undefined;
      state.deps.resolveDefaultAgentId = () => currentDefault;
      await finalizeAlertOutcome({
        state,
        job,
        status: "error",
        error: "provider unavailable",
        startedAt: dueAt,
        endedAt,
      });
      expect(send).toHaveBeenCalledOnce();
      currentDefault = "beta";
      delivery.resolve();
      const [settlement] = await Promise.allSettled([send.mock.results[0]?.value]);
      expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
        lastFailureAlertAtMs: endedAt,
        lastFailureNotificationDelivered: false,
        lastFailureNotificationDeliveryStatus: "not-delivered",
      });
      if (initialOwner) {
        expect(settlement).toMatchObject({ status: "fulfilled" });
        expect(state.deps.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          expect.objectContaining({ agentId: "alpha" }),
        );
        expect(state.deps.requestHeartbeat).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ agentId: "alpha" }),
        );
      } else {
        expect(settlement).toMatchObject({
          status: "rejected",
          reason: new Error(CRON_AGENT_SELECTION_REQUIRED_MESSAGE),
        });
        expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
        expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["explicit transport owner", "queue session owner"] as const)(
    "delivers to the %s when the default getter becomes unavailable after commit",
    async (owner) => {
      const store = fixtures.makeStorePath();
      const job = createAlertJob({ id: "alert-owned-without-default", dueAt });
      job.wakeMode = "now";
      if (owner === "explicit transport owner") {
        job.agentId = "alpha";
      } else {
        job.sessionTarget = "session:agent:session-owner:main";
        job.sessionKey = "agent:creator-owner:main";
      }
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });
      const send = vi.fn<SendCronFailureAlert>(async (params) => {
        await params.onDeliverySettled({ delivered: true, status: "delivered" });
      });
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => endedAt,
        sendCronFailureAlert: send,
      });
      if (owner === "queue session owner") {
        state.deps.sendCronFailureAlert = undefined;
      }
      state.deps.resolveDefaultAgentId = () => "other";
      const finished = vi.fn(() => {
        state.deps.resolveDefaultAgentId = () => {
          throw new Error("default routing unavailable");
        };
      });
      state.deps.onEvent = (event) => {
        if (event.action === "finished") {
          finished();
        }
      };
      await finalizeAlertOutcome({
        state,
        job,
        status: "error",
        error: "provider unavailable",
        startedAt: dueAt,
        endedAt,
      });
      expect(finished).toHaveBeenCalledOnce();
      expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
        lastRunStatus: "error",
        lastFailureAlertAtMs: endedAt,
      });
      if (owner === "explicit transport owner") {
        expect(send).toHaveBeenCalledOnce();
        await send.mock.results[0]?.value;
        expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
          lastFailureNotificationDelivered: true,
          lastFailureNotificationDeliveryStatus: "delivered",
        });
        expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
      } else {
        expect(send).not.toHaveBeenCalled();
        expect(state.deps.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining('Automation "alert-owned-without-default" failed 1 times'),
          expect.objectContaining({
            agentId: "session-owner",
            sessionKey: "agent:session-owner:main",
          }),
        );
        expect(state.deps.requestHeartbeat).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            agentId: "session-owner",
            sessionKey: "agent:session-owner:main",
          }),
        );
      }
    },
  );

  it("redacts transport errors and persists them without host SQL", async () => {
    const err = new Error(
      `webhook rejected: token=abcdefghijklmnopqrstuvwxyz123456 ${"x".repeat(2_000)}`,
    );
    let hostStatements = 0;
    const send = vi.fn<SendCronFailureAlert>(async (params) => {
      const statements = observeHostDataSql();
      try {
        await params.onDeliverySettled({
          delivered: false,
          status: "not-delivered",
          error: err.message,
        });
        hostStatements = statements.calls.reduce((sum, call) => sum + call.mock.calls.length, 0);
      } finally {
        statements.restore();
      }
    });
    const { store } = await runFailure({
      id: "alert-outcome-redacted-error",
      sendCronFailureAlert: send,
    });
    expect(send).toHaveBeenCalledOnce();
    await send.mock.results[0]?.value;
    expect(hostStatements).toBe(0);
    expect(
      (await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureNotificationDeliveryStatus,
    ).toBe("not-delivered");
    const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state
      .lastFailureNotificationDeliveryError;
    expect(persisted).toHaveLength(1_000);
    expect(formatErrorMessage(err).length).toBeGreaterThan(1_000);
    expect(persisted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it.each(["sibling cycle", "newer run", "retired lifecycle"] as const)(
    "rejects a delayed outcome after a %s takes ownership",
    async (replacement) => {
      const gate = createDeferred();
      const send = vi.fn<SendCronFailureAlert>(async (params) => {
        await gate.promise;
        await params.onDeliverySettled(
          replacement === "sibling cycle"
            ? { delivered: true, status: "delivered" }
            : { delivered: false, status: "not-delivered" },
        );
      });
      const { store, state, job } = await runFailure({
        id: "alert-outcome-stale",
        sendCronFailureAlert: send,
      });
      const laterAt = endedAt + (replacement === "sibling cycle" ? 600_000 : 1_000);
      if (replacement === "retired lifecycle") {
        stopCronService(state);
      } else if (replacement === "sibling cycle") {
        const siblingSend = vi.fn<SendCronFailureAlert>(async (params) => {
          await params.onDeliverySettled({
            delivered: false,
            status: "not-delivered",
            error: "recipient not reached",
          });
        });
        const sibling = createAlertState({
          storePath: store.storePath,
          nowMs: () => laterAt,
          sendCronFailureAlert: siblingSend,
        });
        const siblingJob = structuredClone(job);
        siblingJob.state.runningAtMs = laterAt;
        await finalizeAlertOutcome({
          state: sibling,
          job: siblingJob,
          status: "error",
          error: "provider unavailable again",
          startedAt: laterAt - 10,
          endedAt: laterAt,
        });
        expect(siblingSend).toHaveBeenCalledOnce();
        await siblingSend.mock.results[0]?.value;
        expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureAlertAtMs).toBe(
          laterAt,
        );
      } else {
        const currentJob = state.store?.jobs[0];
        if (!currentJob) {
          throw new Error("expected persisted cron job");
        }
        currentJob.state.runningAtMs = laterAt;
        await finalizeAlertOutcome({
          state,
          job: currentJob,
          status: "error",
          error: "provider still unavailable",
          startedAt: laterAt,
          endedAt: laterAt + 10,
        });
        expect(send).toHaveBeenCalledOnce();
      }
      gate.resolve();
      await send.mock.results[0]?.value;
      await Promise.resolve();
      await state.op;
      await Promise.resolve();
      await state.op;
      const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state;
      if (replacement === "sibling cycle") {
        expect(persisted?.lastFailureAlertAtMs).toBe(laterAt);
        expect(persisted?.lastFailureNotificationDelivered).not.toBe(true);
      } else {
        expect(persisted).toMatchObject(
          replacement === "newer run"
            ? {
                lastRunAtMs: laterAt,
                lastFailureAlertAtMs: endedAt,
                lastFailureNotificationDeliveryStatus: "not-requested",
              }
            : { lastFailureNotificationDeliveryStatus: "unknown" },
        );
        expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
      }
    },
  );

  it("restores the live fields when the outcome persist fails", async () => {
    const sendGate = createDeferred();
    const sendCronFailureAlert = vi.fn<SendCronFailureAlert>(async (params) => {
      await sendGate.promise;
      await params.onDeliverySettled({ delivered: false, status: "not-delivered" });
    });
    const { store, state, job } = await runFailure({
      id: "alert-outcome-persist-restore",
      sendCronFailureAlert,
    });

    // The run itself is durable; from here on every write to this row fails.
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TRIGGER reject_outcome_write
      BEFORE UPDATE ON cron_jobs
      WHEN NEW.store_key = '${cronStoreKey(store.storePath)}' AND NEW.job_id = '${job.id}'
      BEGIN
        SELECT RAISE(ABORT, 'outcome write failed');
      END;
    `);
    try {
      sendGate.resolve();
      await sendCronFailureAlert.mock.results[0]?.value;
      await Promise.resolve();
      await state.op;
      await Promise.resolve();
      await state.op;

      // The live gateway must not report an outcome SQLite refused to commit.
      const live = state.store?.jobs[0]?.state;
      expect(live?.lastFailureNotificationDeliveryStatus).toBe("unknown");
      expect(live?.lastFailureNotificationDelivered).toBeUndefined();
      expect(live?.lastFailureNotificationDeliveryError).toBeUndefined();
      const durable = (await loadCronStore(store.storePath)).jobs[0]?.state;
      expect(durable?.lastFailureNotificationDeliveryStatus).toBe("unknown");
      expect(durable?.lastFailureNotificationDelivered).toBeUndefined();
      expect(durable?.lastFailureNotificationDeliveryError).toBeUndefined();
      expect(state.deps.enqueueSystemEvent).toHaveBeenCalledOnce();
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_outcome_write;");
    }
  });
});

function createFixture() {
  const store = fixtures.makeStorePath();
  const clock = { now: Date.parse("2026-08-01T15:00:00Z") };
  const job = createDueIsolatedJob({
    id: "recovery-monitor",
    nowMs: clock.now,
    nextRunAtMs: clock.now,
  });
  job.schedule = { kind: "every", everyMs: 60_000, anchorMs: clock.now };
  job.delivery = { mode: "none" };
  job.failureAlert = { after: 1, cooldownMs: 60_000 };
  const sendCronFailureAlert = vi.fn(async () => undefined);
  const state = createCronRegressionState({
    storePath: store.storePath,
    nowMs: () => clock.now,
    sendCronFailureAlert,
    runIsolatedAgentJob: vi.fn(),
  });
  return { store, clock, job, state, sendCronFailureAlert };
}

async function finalize(
  context: ReturnType<typeof createFixture>,
  job: CronJob,
  result: CronRunOutcome,
) {
  await finalizeCompletedCronRunOutcomes(context.state, [
    {
      jobId: job.id,
      job: structuredClone(job),
      activeJobMarker: markCronJobActive(job.id),
      ...authorCronRunCompletion(job, result),
      startedAt: context.clock.now,
      endedAt: context.clock.now + 10,
    },
  ]);
}

describe("cron failure incident startup recovery", () => {
  it("reopens a recurring failure after replaying success whose job-row commit failed", async () => {
    const context = createFixture();
    const { store, clock, state, sendCronFailureAlert } = context;
    await saveCronStore(store.storePath, { version: 1, jobs: [context.job] });
    await finalize(context, context.job, { status: "error", error: "monitor failed" });
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    const pendingJob = (await loadCronStore(store.storePath)).jobs[0]!;
    clock.now += 1_000;
    pendingJob.state.runningAtMs = clock.now;
    await saveCronStore(store.storePath, { version: 1, jobs: [pendingJob] });
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TRIGGER reject_recovered_cron_row
      BEFORE UPDATE ON cron_jobs
      WHEN NEW.store_key = '${cronStoreKey(store.storePath)}' AND NEW.job_id = '${pendingJob.id}'
      BEGIN
        SELECT RAISE(ABORT, 'recovery row write failed');
      END;
    `);
    try {
      await expect(finalize(context, pendingJob, { status: "ok" })).rejects.toThrow(
        "recovery row write failed",
      );
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_recovered_cron_row");
    }
    const entry = readCronRunHistoryPageForTests({
      storeKey: cronStoreKey(store.storePath),
      jobId: pendingJob.id,
      status: "ok",
    }).entries[0];
    if (!entry || entry.status !== "ok") {
      throw new Error("expected durable successful task history");
    }
    const staleJob = (await loadCronStore(store.storePath)).jobs[0]!;
    expect(staleJob.state.failureAlertIncident?.signature).toBeDefined();
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    const notifications: DeferredCronNotifications = [];
    restoreFinalizedStartupRun({
      state,
      job: staleJob,
      runningAtMs: clock.now,
      entry: { ...entry, status: "ok" },
      deferredNotifications: notifications,
    });
    expect(notifications).toEqual([]);
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    expect(staleJob.state.failureAlertIncident).toBeUndefined();
    expect(staleJob.state.lastFailureAlertAtMs).toBeUndefined();
    await saveCronStore(store.storePath, { version: 1, jobs: [staleJob] });

    clock.now += 1_000;
    await finalize(context, staleJob, { status: "error", error: "monitor failed" });
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
  });

  it.each(["trigger", "payload"] as const)(
    "reconciles a quiet startup check after a %s failure without historical notifications",
    async (source) => {
      const { state, job, clock, sendCronFailureAlert } = createFixture();
      await applyJobResultAndDrainNotifications(state, job, {
        status: "error",
        error: "plugin refresh failed",
        ...cronScriptFailureMetadata(source, "plugin_reload_failed"),
        startedAt: clock.now,
        endedAt: clock.now,
      });
      const notifications: DeferredCronNotifications = [];
      restoreFinalizedStartupRun({
        state,
        job,
        runningAtMs: clock.now + 1_000,
        entry: {
          action: "finished",
          jobId: job.id,
          status: "ok",
          ts: clock.now + 1_001,
          runAtMs: clock.now + 1_000,
        },
        triggerEval: { fired: false, stateChanged: false },
        deferredNotifications: notifications,
      });
      expect(notifications).toEqual([]);
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect(job.state.failureAlertIncident?.scope).toBe(source === "trigger" ? undefined : "run");
    },
  );

  it("keeps a replayed failure without script detail unresolved through a quiet trigger check", async () => {
    const { state, job, clock, sendCronFailureAlert } = createFixture();
    await applyJobResultAndDrainNotifications(state, job, {
      status: "error",
      error: "plugin refresh failed",
      ...cronScriptFailureMetadata("trigger", "plugin_reload_failed"),
      startedAt: clock.now,
      endedAt: clock.now,
    });
    const notifications: DeferredCronNotifications = [];
    restoreFinalizedStartupRun({
      state,
      job,
      runningAtMs: clock.now + 1_000,
      entry: {
        action: "finished",
        jobId: job.id,
        status: "error",
        error: "script failed",
        ts: clock.now + 1_001,
        runAtMs: clock.now + 1_000,
      },
      deferredNotifications: notifications,
    });
    applyTriggerNoFireResult(
      state,
      job,
      {
        startedAt: clock.now + 2_000,
        endedAt: clock.now + 2_001,
        triggerEval: { fired: false, stateChanged: false },
      },
      { deferredNotifications: notifications },
    );
    expect(notifications).toEqual([]);
    expect(job.state.failureAlertIncident?.scope).toBe("run");
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
  });
});
