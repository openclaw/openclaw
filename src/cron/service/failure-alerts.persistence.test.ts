// Failure alerts must describe only cron outcomes that survived durable persistence.
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { setupCronRegressionFixtures } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
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
import {
  applyJobResultAndDrainNotifications,
  applyTriggerNoFireResultAndDrainNotifications,
} from "./notification.test-helpers.js";
import { restoreFinalizedStartupRun } from "./startup-run-repair.js";
import type { DeferredCronNotifications } from "./state.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-failure-alert-persistence-" });
type Outcome = Parameters<typeof applyJobResultAndDrainNotifications>[2];
type TimelessOutcome = Omit<Outcome, "startedAt" | "endedAt"> &
  Partial<Pick<Outcome, "startedAt" | "endedAt">>;
const alertDelivery = {
  mode: "announce",
  failureDestination: { mode: "webhook", to: "https://alerts.example.test/cron" },
} satisfies CronJob["delivery"];

function alertFixture(
  nowMs: () => number,
  dueAt = nowMs(),
  send = vi.fn<SendCronFailureAlert>(async () => undefined),
) {
  const store = fixtures.makeStorePath();
  const job = createAlertJob({ id: crypto.randomUUID(), dueAt });
  const state = createAlertState({ storePath: store.storePath, nowMs, sendCronFailureAlert: send });
  const outcome = (result: TimelessOutcome) =>
    applyJobResultAndDrainNotifications(state, job, {
      startedAt: nowMs(),
      endedAt: nowMs(),
      ...result,
    });
  const finalize = (
    status: Parameters<typeof finalizeAlertOutcome>[0]["status"],
    error?: string,
    target = state.store?.jobs[0] ?? job,
    startedAt = nowMs(),
    targetState = state,
  ) =>
    finalizeAlertOutcome({
      state: targetState,
      job: target,
      status,
      error,
      startedAt,
      endedAt: startedAt + 10,
    });
  const quiet = (startedAt = nowMs(), endedAt = startedAt, busy?: true) =>
    applyTriggerNoFireResultAndDrainNotifications(state, job, {
      startedAt,
      endedAt,
      triggerEval: { fired: false, stateChanged: false, ...(busy === undefined ? {} : { busy }) },
    });
  const persist = () => saveCronStore(store.storePath, { version: 1, jobs: [job] });
  const durable = async () => (await loadCronStore(store.storePath)).jobs[0]?.state;
  const failDelivery = (status: "error" | "ok" = "ok") =>
    outcome({
      status,
      delivered: false,
      error: status === "error" ? "execution failed" : undefined,
      deliveryError: "primary rejected",
    });
  return { store, job, state, send, outcome, finalize, quiet, persist, durable, failDelivery };
}

it("shares cooldown across alternating execution and delivery failures", async () => {
  let now = Date.parse("2026-08-01T14:49:00Z");
  const { job, send, outcome, failDelivery } = alertFixture(() => now);
  job.delivery = structuredClone(alertDelivery);
  for (const status of ["error", "ok"] as const) {
    await failDelivery(status);
    now += 1_000;
  }
  expect(send).toHaveBeenCalledOnce();
  await outcome({ status: "ok", delivered: true });
  expect(job.state.lastFailureAlertAtMs).toBeUndefined();
  expect(job.state.failureAlertIncident).toBeUndefined();
  expect(send).toHaveBeenCalledOnce();
  await failDelivery();
  expect(send).toHaveBeenCalledTimes(2);
});

it.each(["skipped run", "quiet trigger"])(
  "keeps delivery cooldown across a %s",
  async (intervening) => {
    const firstAt = Date.parse("2026-08-01T14:49:00Z");
    let now = firstAt;
    const { job, send, outcome, quiet, failDelivery } = alertFixture(() => now);
    job.delivery = structuredClone(alertDelivery);
    await failDelivery();
    expect(send).toHaveBeenCalledOnce();
    now += 1_000;
    if (intervening === "skipped run") {
      await outcome({ status: "skipped" });
    } else {
      await quiet();
    }
    now += 1_000;
    await failDelivery();
    expect(send).toHaveBeenCalledOnce();
    expect(job.state.lastFailureAlertAtMs).toBe(firstAt);
  },
);

it.each([
  ["recorded error", { status: "unknown" }, -20_000, 0, "error", true],
  ["recorded intent with alerts disabled", { status: "unknown" }, -20_000, 0, "ok", false],
  ["newer alert", { status: "delivered", delivered: true }, 10_000, 10_000, "error", false],
] as const)(
  "restores cooldown from %s without transport",
  (_name, notification, priorOffset, expectedOffset, status, enabled) => {
    const endedAt = Date.parse("2026-08-01T14:50:00Z");
    const { job, state, send } = alertFixture(() => endedAt + 30_000, endedAt - 10);
    job.delivery = { mode: "none" };
    job.failureAlert = enabled ? { after: 1, cooldownMs: 60_000, includeSkipped: true } : false;
    job.state.lastFailureAlertAtMs = endedAt + priorOffset;
    const deferredNotifications: DeferredCronNotifications = [];
    restoreFinalizedStartupRun({
      state,
      job,
      runningAtMs: endedAt - 10,
      deferredNotifications,
      entry: {
        ts: endedAt,
        jobId: job.id,
        action: "finished",
        status,
        completionStatus: "failed",
        deliveryStatus: "not-delivered",
        deliveryError: "primary rejected",
        failureNotificationDelivery: notification,
        runAtMs: endedAt - 10,
      },
    });
    expect(job.state.lastFailureAlertAtMs).toBe(endedAt + expectedOffset);
    expect(job.state.lastFailureNotificationDeliveryStatus).toBe(notification.status);
    expect(deferredNotifications).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(state.deps.enqueueSessionEvent).not.toHaveBeenCalled();
  },
);

it("resumes skipped alerts after a clock rollback only after durable persistence", async () => {
  const dueAt = Date.parse("2026-08-01T14:52:00.000Z");
  let now = dueAt;
  let durableAtSend: CronJob["state"] | undefined;
  const send = vi.fn(async () => {
    durableAtSend = await durable();
  });
  const { job, state, persist, durable, finalize } = alertFixture(() => now, now, send);
  job.failureAlert = { after: 1, cooldownMs: 60_000, includeSkipped: true };
  job.state.lastFailureAlertAtMs = dueAt + 3_600_000;
  await persist();
  await finalize("skipped", "provider unavailable");

  expect(send).toHaveBeenCalledOnce();
  await send.mock.results[0]?.value;
  expect(durableAtSend).toMatchObject({
    lastFailureAlertAtMs: dueAt,
    lastFailureNotificationDeliveryStatus: "unknown",
  });
  expect((await durable())?.lastFailureAlertAtMs).toBe(now);

  now += 30_000;
  assert(state.store?.jobs[0], "expected persisted cron job");
  await finalize("skipped", "provider still unavailable");

  expect(send).toHaveBeenCalledOnce();
  expect((await durable())?.lastFailureAlertAtMs).toBe(dueAt);
});

it("rolls back the cooldown without delivery when persistence fails", async () => {
  const dueAt = Date.parse("2026-08-01T14:55:00.000Z");
  const { store, job, state, persist, durable, finalize, send } = alertFixture(
    () => dueAt + 10,
    dueAt,
  );
  await persist();
  const database = openOpenClawStateDatabase().db;
  database.exec(`
    CREATE TRIGGER reject_failure_alert_terminal_write
    BEFORE UPDATE ON cron_jobs
    WHEN NEW.store_key = '${cronStoreKey(store.storePath)}' AND NEW.job_id = '${job.id}'
    BEGIN
      SELECT RAISE(ABORT, 'terminal write failed');
    END;
  `);

  try {
    await expect(finalize("error", "provider unavailable", job, dueAt)).rejects.toThrow(
      "terminal write failed",
    );

    expect(send).not.toHaveBeenCalled();
    expect(state.store?.jobs[0]?.state.lastFailureAlertAtMs).toBeUndefined();
    expect((await durable())?.lastFailureAlertAtMs).toBeUndefined();
  } finally {
    database.exec("DROP TRIGGER IF EXISTS reject_failure_alert_terminal_write");
  }
});

it("persists an incident and suppresses repeats after a service reload past cooldown", async () => {
  const dueAt = Date.parse("2026-08-01T14:58:00.000Z");
  const firstAlertAt = dueAt + 10;
  let now = firstAlertAt;
  const { store, state, persist, durable, finalize, send } = alertFixture(() => now, dueAt);
  await persist();
  await finalize("error", "first failure", undefined, dueAt);
  expect(send).toHaveBeenCalledOnce();
  expect(await durable()).toMatchObject({
    lastFailureAlertAtMs: firstAlertAt,
    lastFailureNotificationDeliveryStatus: "unknown",
  });

  const currentJob = state.store?.jobs[0];
  assert(currentJob, "expected persisted cron job");
  now += 90_000;
  const reloadedState = createAlertState({
    storePath: store.storePath,
    nowMs: () => now,
    sendCronFailureAlert: send,
  });
  await finalize("error", "first failure", currentJob, now, reloadedState);
  expect(send).toHaveBeenCalledOnce();
  expect((await durable())?.failureAlertIncident).toBeDefined();
});

it("keeps a trigger incident unresolved while its quiet evaluation is busy", async () => {
  const now = Date.parse("2026-08-01T15:00:00Z");
  const { job, outcome, quiet, send } = alertFixture(() => now);
  await outcome({
    status: "error",
    error: "plugin reload failed",
    failureNotificationDetail: {
      kind: "script-failure",
      source: "trigger",
      code: "plugin_reload_failed",
    },
  });
  await quiet(now + 1_000, now + 1_001, true);
  // Recovery is silent; only the original failure alert is ever sent.
  expect(send).toHaveBeenCalledOnce();
  expect(job.state.failureAlertIncident).toBeDefined();
});

it.each([1, 3])(
  "keeps a payload failure open across trigger checks (threshold=%s)",
  async (after) => {
    let now = Date.parse("2026-08-01T15:00:00Z");
    const { job, quiet, outcome, send } = alertFixture(() => now);
    const fail = (source: "trigger" | "payload", code: "timeout" | "plugin_reload_failed") =>
      outcome({
        status: "error",
        error: "script failure",
        ...cronScriptFailureMetadata(source, code),
      });
    await fail("trigger", "timeout");
    job.failureAlert = { after, cooldownMs: 60_000 };
    now += 1_000;
    await fail("payload", "timeout");
    expect(send).toHaveBeenCalledOnce();
    now += 60_000;
    await fail("trigger", "plugin_reload_failed");
    expect(send).toHaveBeenCalledTimes(2);
    await quiet(now + 1_000, now + 1_001);
    expect(send).toHaveBeenCalledTimes(2);
    expect(job.state.failureAlertIncident?.scope).toBe("run");
    await outcome({
      status: "ok",
      startedAt: now + 2_000,
      endedAt: now + 2_001,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(job.state.failureAlertIncident).toBeUndefined();
  },
);
