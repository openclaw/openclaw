import { expect, it, vi } from "vitest";
import { setupCronRegressionFixtures } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import { cronScriptFailureMetadata } from "../script-failure.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";
import {
  createAlertJob,
  createAlertState,
  finalizeAlertOutcome,
  type SendCronFailureAlert,
} from "./failure-alerts.test-support.js";
import { applyJobResultAndDrainNotifications } from "./notification.test-helpers.js";
import { start as startCronService, stop as stopCronService } from "./ops-lifecycle.js";
import { finishCronRun } from "./run-history.js";
import { restoreFinalizedStartupRun } from "./startup-run-repair.js";
import type { DeferredCronNotifications } from "./state.js";
import { applyTriggerNoFireResult } from "./timer-outcomes.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-failure-alert-outcome-" });

const dueAt = Date.parse("2026-08-01T15:00:00.000Z");
const endedAt = dueAt + 10;
type State = ReturnType<typeof createAlertState>;
type Delivery = Parameters<Parameters<SendCronFailureAlert>[0]["onDeliverySettled"]>[0];

function sender(result: Delivery, gate?: { promise: Promise<unknown> }) {
  return vi.fn<SendCronFailureAlert>(async ({ onDeliverySettled }) => {
    if (gate) {
      await gate.promise;
    }
    await onDeliverySettled(result);
  });
}

async function fixture(id: string, send: SendCronFailureAlert, overrides: Partial<CronJob> = {}) {
  const { storePath } = fixtures.makeStorePath();
  const job = Object.assign(createAlertJob({ id, dueAt }), overrides);
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const state = createAlertState({ storePath, nowMs: () => endedAt, sendCronFailureAlert: send });
  const read = async () => (await loadCronStore(storePath)).jobs[0]?.state;
  return { state, job, storePath, read };
}

function fail(state: State, job: CronJob, startedAt = dueAt, error = "provider unavailable") {
  return finalizeAlertOutcome({
    state,
    job,
    status: "error",
    error,
    startedAt,
    endedAt: startedAt + 10,
  });
}

async function runFailure(id: string, send: SendCronFailureAlert) {
  const f = await fixture(id, send);
  await fail(f.state, f.job);
  return f;
}

async function drain(state: State) {
  await Promise.resolve();
  await state.op;
  await Promise.resolve();
  await state.op;
}

function expectQueued(
  state: State,
  target: { agentId: string; sessionKey?: string },
  message = expect.any(String),
) {
  const options = expect.objectContaining(target);
  expect(state.deps.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(message, options);
  expect(state.deps.requestHeartbeat).toHaveBeenCalledExactlyOnceWith(options);
}

it.each(["alpha", undefined])(
  "keeps initial owner %s for delayed failure fallback after the default changes",
  async (initialOwner) => {
    const delivery = createDeferred();
    const send = sender({ delivered: false, status: "not-delivered" }, delivery);
    const { state, job, read } = await fixture("alert-delayed-fallback-routing", send, {
      wakeMode: "now",
    });
    let currentDefault = initialOwner;
    state.deps.defaultAgentId = undefined;
    state.deps.resolveDefaultAgentId = () => currentDefault;
    await fail(state, job);
    expect(send).toHaveBeenCalledOnce();
    currentDefault = "beta";
    delivery.resolve();
    const [settlement] = await Promise.allSettled([send.mock.results[0]?.value]);
    expect(await read()).toMatchObject({
      lastFailureAlertAtMs: endedAt,
      lastFailureNotificationDelivered: false,
      lastFailureNotificationDeliveryStatus: "not-delivered",
    });
    if (initialOwner) {
      expect(settlement).toMatchObject({ status: "fulfilled" });
      expectQueued(state, { agentId: "alpha" });
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
    const send = sender({ delivered: true, status: "delivered" });
    const transport = owner === "explicit transport owner";
    const { state, job, read } = await fixture("alert-owned-without-default", send, {
      wakeMode: "now",
      ...(transport
        ? { agentId: "alpha" }
        : {
            sessionTarget: "session:agent:session-owner:main",
            sessionKey: "agent:creator-owner:main",
          }),
    });
    if (!transport) {
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
    await fail(state, job);
    expect(finished).toHaveBeenCalledOnce();
    expect(await read()).toMatchObject({ lastRunStatus: "error", lastFailureAlertAtMs: endedAt });
    if (transport) {
      expect(send).toHaveBeenCalledOnce();
      await send.mock.results[0]?.value;
      expect(await read()).toMatchObject({
        lastFailureNotificationDelivered: true,
        lastFailureNotificationDeliveryStatus: "delivered",
      });
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    } else {
      expect(send).not.toHaveBeenCalled();
      expectQueued(
        state,
        { agentId: "session-owner", sessionKey: "agent:session-owner:main" },
        expect.stringContaining('Automation "alert-owned-without-default" failed 1 times'),
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
  const { read } = await runFailure("alert-outcome-redacted-error", send);
  expect(send).toHaveBeenCalledOnce();
  await send.mock.results[0]?.value;
  expect(hostStatements).toBe(0);
  const durable = await read();
  expect(durable?.lastFailureNotificationDeliveryStatus).toBe("not-delivered");
  const persisted = durable?.lastFailureNotificationDeliveryError;
  expect(persisted).toHaveLength(1_000);
  expect(persisted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
});

it.each(["sibling cycle", "newer run", "retired lifecycle"] as const)(
  "rejects a delayed outcome after a %s takes ownership",
  async (replacement) => {
    const gate = createDeferred();
    const siblingCycle = replacement === "sibling cycle";
    const send = sender(
      siblingCycle
        ? { delivered: true, status: "delivered" }
        : { delivered: false, status: "not-delivered" },
      gate,
    );
    const { storePath, state, job, read } = await runFailure("alert-outcome-stale", send);
    const laterAt = endedAt + (siblingCycle ? 600_000 : 1_000);
    if (replacement === "retired lifecycle") {
      stopCronService(state);
    } else if (siblingCycle) {
      const siblingSend = sender({
        delivered: false,
        status: "not-delivered",
        error: "recipient not reached",
      });
      const sibling = createAlertState({
        storePath,
        nowMs: () => laterAt,
        sendCronFailureAlert: siblingSend,
      });
      const siblingJob = structuredClone(job);
      siblingJob.state.runningAtMs = laterAt;
      await fail(sibling, siblingJob, laterAt - 10, "provider unavailable again");
      expect(siblingSend).toHaveBeenCalledOnce();
      await siblingSend.mock.results[0]?.value;
      expect((await read())?.lastFailureAlertAtMs).toBe(laterAt);
    } else {
      const currentJob = state.store?.jobs[0];
      if (!currentJob) {
        throw new Error("expected persisted cron job");
      }
      currentJob.state.runningAtMs = laterAt;
      await fail(state, currentJob, laterAt, "provider still unavailable");
      expect(send).toHaveBeenCalledOnce();
    }
    gate.resolve();
    await send.mock.results[0]?.value;
    await drain(state);
    const persisted = await read();
    if (siblingCycle) {
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
  const send = sender({ delivered: false, status: "not-delivered" }, sendGate);
  const { storePath, state, job, read } = await runFailure("alert-outcome-persist-restore", send);
  // The run itself is durable; from here on every write to this row fails.
  const database = openOpenClawStateDatabase().db;
  database.exec(`
      CREATE TRIGGER reject_outcome_write
      BEFORE UPDATE ON cron_jobs
      WHEN NEW.store_key = '${cronStoreKey(storePath)}' AND NEW.job_id = '${job.id}'
      BEGIN
        SELECT RAISE(ABORT, 'outcome write failed');
      END;
    `);
  try {
    sendGate.resolve();
    await send.mock.results[0]?.value;
    await drain(state);
    // The live gateway must not report an outcome SQLite refused to commit.
    const live = state.store?.jobs[0]?.state;
    const durable = await read();
    for (const result of [live, durable]) {
      expect(result?.lastFailureNotificationDeliveryStatus).toBe("unknown");
      expect(result?.lastFailureNotificationDelivered).toBeUndefined();
      expect(result?.lastFailureNotificationDeliveryError).toBeUndefined();
    }
    expect(state.deps.enqueueSystemEvent).toHaveBeenCalledOnce();
  } finally {
    database.exec("DROP TRIGGER IF EXISTS reject_outcome_write;");
  }
});
function createFixture() {
  const store = fixtures.makeStorePath();
  const clock = { now: Date.parse("2026-08-01T15:00:00Z") };
  const job = createAlertJob({ id: "recovery-monitor", dueAt: clock.now });
  job.schedule = { kind: "every", everyMs: 60_000, anchorMs: clock.now };
  delete job.state.runningAtMs;
  const sendCronFailureAlert = vi.fn(async () => undefined);
  const state = createAlertState({
    storePath: store.storePath,
    nowMs: () => clock.now,
    sendCronFailureAlert,
  });
  const scriptFailure = (source: "trigger" | "payload") =>
    applyJobResultAndDrainNotifications(state, job, {
      status: "error",
      error: "plugin refresh failed",
      ...cronScriptFailureMetadata(source, "plugin_reload_failed"),
      startedAt: clock.now,
      endedAt: clock.now,
    });
  const replay = (status: "ok" | "error", quiet = false, error?: string) => {
    const notifications: DeferredCronNotifications = [];
    restoreFinalizedStartupRun({
      state,
      job,
      runningAtMs: clock.now + 1_000,
      entry: {
        action: "finished",
        jobId: job.id,
        status,
        ...(error ? { error } : {}),
        ts: clock.now + 1_001,
        runAtMs: clock.now + 1_000,
      },
      ...(quiet ? { triggerEval: { fired: false, stateChanged: false } } : {}),
      deferredNotifications: notifications,
    });
    return notifications;
  };
  return { store, clock, job, state, send: sendCronFailureAlert, scriptFailure, replay };
}

it("reopens a recurring failure after recovering a released split-commit success", async () => {
  const context = createFixture();
  const { store, clock, state, send } = context;
  await saveCronStore(store.storePath, { version: 1, jobs: [context.job] });
  await fail(state, context.job, clock.now, "monitor failed");
  expect(send).toHaveBeenCalledOnce();
  const pendingJob = (await loadCronStore(store.storePath)).jobs[0]!;
  clock.now += 1_000;
  pendingJob.state.runningAtMs = clock.now;
  await saveCronStore(store.storePath, { version: 1, jobs: [pendingJob] });
  // Released schedulers could persist terminal history before the separate job update.
  await finishCronRun(state, {
    job: pendingJob,
    event: {
      jobId: pendingJob.id,
      action: "finished",
      status: "ok",
      completionStatus: "succeeded",
      runAtMs: clock.now,
      durationMs: 10,
      deliveryStatus: "not-requested",
      nextRunAtMs: context.job.createdAtMs + 60_000,
    },
  });
  const recorded = readCronRunHistoryPageForTests({
    storeKey: cronStoreKey(store.storePath),
    jobId: pendingJob.id,
    status: "ok",
  }).entries;
  expect(recorded).toMatchObject([{ status: "ok", runAtMs: clock.now }]);
  const before = (await loadCronStore(store.storePath)).jobs[0]!;
  expect(before.state.failureAlertIncident?.signature).toBeDefined();
  expect(before.state.runningAtMs).toBe(clock.now);
  expect(send).toHaveBeenCalledOnce();
  try {
    await startCronService(state);
    const recovered = (await loadCronStore(store.storePath)).jobs[0]!;
    expect(recovered.state.runningAtMs).toBeUndefined();
    expect(recovered.state.failureAlertIncident).toBeUndefined();
    expect(recovered.state.lastFailureAlertAtMs).toBeUndefined();
    expect(recovered.state.lastRunStatus).toBe("ok");
    expect(send).toHaveBeenCalledOnce();

    clock.now += 1_000;
    await fail(state, recovered, clock.now, "monitor failed");
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    stopCronService(state);
    await state.schedulerDrain;
  }
});

it.each(["trigger", "payload"] as const)(
  "reconciles a quiet startup check after a %s failure without historical notifications",
  async (source) => {
    const { job, send, scriptFailure, replay } = createFixture();
    await scriptFailure(source);
    const notifications = replay("ok", true);
    expect(notifications).toEqual([]);
    expect(send).toHaveBeenCalledOnce();
    expect(job.state.failureAlertIncident?.scope).toBe(source === "trigger" ? undefined : "run");
  },
);

it("keeps a replayed failure without script detail unresolved through a quiet trigger check", async () => {
  const { state, job, clock, send, scriptFailure, replay } = createFixture();
  await scriptFailure("trigger");
  const notifications = replay("error", false, "script failed");
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
  expect(send).toHaveBeenCalledOnce();
});
