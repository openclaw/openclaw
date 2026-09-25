// Failure alerts must describe only cron outcomes that survived durable persistence.
import { describe, expect, it, vi } from "vitest";
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
import { applyJobResult } from "./timer.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-failure-alert-persistence-",
});

describe("cron failure alert persistence", () => {
  it.each(["error", "ok"] as const)(
    "shares cooldown across alternating failures starting %s",
    (firstStatus) => {
      const store = fixtures.makeStorePath();
      let now = Date.parse("2026-08-01T14:49:00Z");
      const job = createAlertJob({ id: "shared-alert-cooldown", dueAt: now });
      job.delivery = {
        mode: "announce",
        failureDestination: { mode: "webhook", to: "https://alerts.example.test/cron" },
      };
      const sendCronFailureAlert = vi.fn<SendCronFailureAlert>(async () => undefined);
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => now,
        sendCronFailureAlert,
      });
      for (const status of [firstStatus, firstStatus === "error" ? "ok" : "error"] as const) {
        applyJobResultAndDrainNotifications(state, job, {
          status,
          delivered: false,
          error: status === "error" ? "execution failed" : undefined,
          deliveryError: "primary rejected",
          startedAt: now,
          endedAt: now,
        });
        now += 1_000;
      }
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      applyJobResultAndDrainNotifications(state, job, {
        status: "ok",
        delivered: true,
        startedAt: now,
        endedAt: now,
      });
      expect(job.state.lastFailureAlertAtMs).toBeUndefined();
      expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
      expect(sendCronFailureAlert.mock.calls[1]?.[0].payload.text).toContain("recovered");
      applyJobResultAndDrainNotifications(state, job, {
        status: "ok",
        delivered: false,
        deliveryError: "primary rejected",
        startedAt: now,
        endedAt: now,
      });
      expect(sendCronFailureAlert).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["skipped run", "quiet trigger"])(
    "keeps delivery cooldown across a %s",
    (intervening) => {
      const store = fixtures.makeStorePath();
      const firstAt = Date.parse("2026-08-01T14:49:00Z");
      let now = firstAt;
      const job = createAlertJob({ id: "delivery-alert-order", dueAt: now });
      job.delivery = {
        mode: "announce",
        failureDestination: { mode: "webhook", to: "https://alerts.example.test/cron" },
      };
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => now,
        sendCronFailureAlert,
      });
      const failDelivery = () =>
        applyJobResultAndDrainNotifications(state, job, {
          status: "ok",
          delivered: false,
          deliveryError: "primary rejected",
          startedAt: now,
          endedAt: now,
        });
      failDelivery();
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      now += 1_000;
      if (intervening === "skipped run") {
        applyJobResultAndDrainNotifications(state, job, {
          status: "skipped",
          startedAt: now,
          endedAt: now,
        });
      } else {
        applyTriggerNoFireResultAndDrainNotifications(state, job, {
          startedAt: now,
          endedAt: now,
          triggerEval: { fired: false, stateChanged: false },
        });
      }
      now += 1_000;
      failDelivery();
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect(job.state.lastFailureAlertAtMs).toBe(firstAt);
    },
  );

  it.each(
    [
      {
        name: "recorded attempt",
        notification: { status: "unknown" as const },
        priorOffset: -20_000,
        expectedOffset: 0,
      },
      {
        name: "newer alert",
        notification: { status: "delivered" as const, delivered: true },
        priorOffset: 10_000,
        expectedOffset: 10_000,
      },
      {
        name: "future timestamp",
        notification: { status: "unknown" as const },
        priorOffset: 120_000,
        expectedOffset: 0,
      },
      {
        name: "suppressed alert",
        notification: { status: "not-requested" as const },
        priorOffset: -120_000,
        expectedOffset: -120_000,
      },
      {
        name: "absent fact",
        notification: undefined,
        priorOffset: -120_000,
        expectedOffset: -120_000,
      },
    ].flatMap((testCase) =>
      (["ok", "error", "skipped"] as const).flatMap((status) =>
        [false, true].map((enabled) => ({ testCase, name: testCase.name, status, enabled })),
      ),
    ),
  )(
    "restores $status cooldown from $name (alerts enabled=$enabled) without transport",
    ({ testCase, status, enabled }) => {
      const endedAt = Date.parse("2026-08-01T14:50:00Z");
      const store = fixtures.makeStorePath();
      const job = createAlertJob({ id: "delivery-replay", dueAt: endedAt - 10 });
      job.delivery = { mode: "none" };
      job.failureAlert = enabled ? { after: 1, cooldownMs: 60_000, includeSkipped: true } : false;
      job.state.lastFailureAlertAtMs = endedAt + testCase.priorOffset;
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => endedAt + 30_000,
        sendCronFailureAlert,
      });
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
          failureNotificationDelivery: testCase.notification,
          runAtMs: endedAt - 10,
        },
      });
      expect(job.state.lastFailureAlertAtMs).toBe(endedAt + testCase.expectedOffset);
      expect(job.state.lastFailureNotificationDeliveryStatus).toBe(
        testCase.notification?.status ?? "not-requested",
      );
      expect(deferredNotifications).toEqual([]);
      expect(sendCronFailureAlert).not.toHaveBeenCalled();
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: "error", includeSkipped: false },
    { status: "skipped", includeSkipped: true },
  ] as const)("delivers a $status alert once after the outcome is durable", async (testCase) => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T14:50:00.000Z");
    const endedAt = dueAt + 10;
    const job = createAlertJob({
      id: `${testCase.status}-alert-after-persist`,
      dueAt,
      includeSkipped: testCase.includeSkipped,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const order: string[] = [];
    let resolveAlert: (() => void) | undefined;
    const alertDone = new Promise<void>((resolve) => {
      resolveAlert = resolve;
    });
    let persistedStateAtSend: CronJob["state"] | undefined;
    const sendCronFailureAlert = vi.fn(async () => {
      persistedStateAtSend = (await loadCronStore(store.storePath)).jobs[0]?.state;
      order.push("persist");
      order.push("alert");
      resolveAlert?.();
    });
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => endedAt,
      sendCronFailureAlert,
    });
    await finalizeAlertOutcome({
      state,
      job,
      status: testCase.status,
      error: testCase.status === "error" ? "provider unavailable" : "disabled",
      startedAt: dueAt,
      endedAt,
    });
    await alertDone;

    expect(order).toEqual(["persist", "alert"]);
    expect(persistedStateAtSend).toMatchObject({
      lastFailureAlertAtMs: endedAt,
      lastFailureNotificationDeliveryStatus: "unknown",
    });
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
  });

  it.each([
    { status: "error", includeSkipped: false },
    { status: "skipped", includeSkipped: true },
  ] as const)(
    "resumes $status alerts after a clock rollback and restores their cooldown",
    async (testCase) => {
      const store = fixtures.makeStorePath();
      const dueAt = Date.parse("2026-08-01T14:52:00.000Z");
      const job = createAlertJob({
        id: `${testCase.status}-alert-clock-rollback`,
        dueAt,
        includeSkipped: testCase.includeSkipped,
      });
      job.state.lastFailureAlertAtMs = dueAt + 3_600_000;
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      let now = dueAt;
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => now,
        sendCronFailureAlert,
      });

      await finalizeAlertOutcome({
        state,
        job,
        status: testCase.status,
        error: "provider unavailable",
        startedAt: now,
        endedAt: now + 10,
      });

      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureAlertAtMs).toBe(now);

      now += 30_000;
      const currentJob = state.store?.jobs[0];
      if (!currentJob) {
        throw new Error("expected persisted cron job");
      }
      await finalizeAlertOutcome({
        state,
        job: currentJob,
        status: testCase.status,
        error: "provider still unavailable",
        startedAt: now,
        endedAt: now + 10,
      });

      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureAlertAtMs).toBe(
        dueAt,
      );
    },
  );

  it("preserves a newer cooldown when replaying an older finalized failure", () => {
    const store = fixtures.makeStorePath();
    const now = Date.parse("2026-08-01T14:54:00.000Z");
    const replayedAt = now - 30_000;
    const previousAlertAt = now - 10_000;
    const job = createAlertJob({ id: "failure-alert-historical-replay", dueAt: replayedAt });
    job.state.lastFailureAlertAtMs = previousAlertAt;

    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => now,
      sendCronFailureAlert,
    });
    const deferredNotifications: DeferredCronNotifications = [];

    applyJobResult(
      state,
      job,
      {
        status: "error",
        error: "historical failure",
        startedAt: replayedAt - 10,
        endedAt: replayedAt,
      },
      { replay: true, deferredNotifications },
    );

    expect(job.state.lastFailureAlertAtMs).toBe(previousAlertAt);
    expect(deferredNotifications).toEqual([]);
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
  });

  it("rolls back the cooldown without delivery when persistence fails", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T14:55:00.000Z");
    const job = createAlertJob({ id: "failure-alert-persist-rollback", dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => dueAt + 10,
      sendCronFailureAlert,
    });
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TEMP TRIGGER reject_failure_alert_terminal_write
      BEFORE UPDATE ON cron_jobs
      WHEN NEW.store_key = '${cronStoreKey(store.storePath)}' AND NEW.job_id = '${job.id}'
      BEGIN
        SELECT RAISE(ABORT, 'terminal write failed');
      END;
    `);

    try {
      await expect(
        finalizeAlertOutcome({
          state,
          job,
          status: "error",
          error: "provider unavailable",
          startedAt: dueAt,
          endedAt: dueAt + 10,
        }),
      ).rejects.toThrow("terminal write failed");

      expect(sendCronFailureAlert).not.toHaveBeenCalled();
      expect(state.store?.jobs[0]?.state.lastFailureAlertAtMs).toBeUndefined();
      expect(
        (await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureAlertAtMs,
      ).toBeUndefined();
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_failure_alert_terminal_write");
    }
  });

  it("persists an incident and suppresses repeats after a service reload past cooldown", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T14:58:00.000Z");
    const firstAlertAt = dueAt + 10;
    const job = createAlertJob({ id: "failure-alert-cooldown-persisted", dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    let now = firstAlertAt;
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => now,
      sendCronFailureAlert,
    });

    await finalizeAlertOutcome({
      state,
      job,
      status: "error",
      error: "first failure",
      startedAt: dueAt,
      endedAt: firstAlertAt,
    });
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
      lastFailureAlertAtMs: firstAlertAt,
      lastFailureNotificationDeliveryStatus: "unknown",
    });

    now += 30_000;
    const currentJob = state.store?.jobs[0];
    if (!currentJob) {
      throw new Error("expected persisted cron job");
    }
    await finalizeAlertOutcome({
      state,
      job: currentJob,
      status: "error",
      error: "first failure",
      startedAt: now,
      endedAt: now + 10,
    });

    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    expect((await loadCronStore(store.storePath)).jobs[0]).toMatchObject({
      state: {
        consecutiveErrors: 2,
        lastFailureAlertAtMs: firstAlertAt,
        lastFailureNotificationDeliveryStatus: "not-requested",
      },
    });

    now += 60_000;
    const reloadedState = createAlertState({
      storePath: store.storePath,
      nowMs: () => now,
      sendCronFailureAlert,
    });
    await finalizeAlertOutcome({
      state: reloadedState,
      job: currentJob,
      status: "error",
      error: "first failure",
      startedAt: now,
      endedAt: now + 10,
    });
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();

    sendCronFailureAlert.mockImplementationOnce(async () => {
      expect(
        (await loadCronStore(store.storePath)).jobs[0]?.state.failureAlertIncident,
      ).toBeUndefined();
    });
    const recoveredJob = reloadedState.store?.jobs[0];
    if (!recoveredJob) {
      throw new Error("expected reloaded cron job");
    }
    now += 1_000;
    await finalizeAlertOutcome({
      state: reloadedState,
      job: recoveredJob,
      status: "ok",
      startedAt: now,
      endedAt: now + 10,
    });
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
    await sendCronFailureAlert.mock.results[1]?.value;
  });

  it.each([
    { source: "trigger", busy: false, recovered: true },
    { source: "trigger", busy: true, recovered: false },
    { source: "payload", busy: false, recovered: false },
  ] as const)(
    "only recovers a $source incident when the quiet trigger succeeds (busy=$busy)",
    ({ source, busy, recovered }) => {
      const store = fixtures.makeStorePath();
      const now = Date.parse("2026-08-01T15:00:00Z");
      const job = createAlertJob({ id: "trigger-recovery-scope", dueAt: now });
      const sendCronFailureAlert = vi.fn<SendCronFailureAlert>(async () => undefined);
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => now,
        sendCronFailureAlert,
      });
      applyJobResultAndDrainNotifications(state, job, {
        status: "error",
        error: "plugin reload failed",
        failureNotificationDetail: { kind: "script-failure", source, code: "plugin_reload_failed" },
        startedAt: now,
        endedAt: now,
      });
      applyTriggerNoFireResultAndDrainNotifications(state, job, {
        startedAt: now + 1_000,
        endedAt: now + 1_001,
        triggerEval: { fired: false, stateChanged: false, ...(busy ? { busy: true } : {}) },
      });
      expect(sendCronFailureAlert).toHaveBeenCalledTimes(recovered ? 2 : 1);
      if (recovered) {
        expect(sendCronFailureAlert.mock.calls[1]?.[0]).toMatchObject({
          payload: {
            text: 'Automation "trigger-recovery-scope" recovered\nThe trigger check completed successfully; no run was needed.',
          },
        });
        expect(sendCronFailureAlert.mock.calls[1]?.[0].runAtMs).toBeUndefined();
        expect(job.state.failureAlertIncident).toBeUndefined();
      } else {
        expect(job.state.failureAlertIncident).toBeDefined();
      }
    },
  );

  it.each([
    { after: 1, triggerFirst: true },
    { after: 3, triggerFirst: true },
    { after: 2, triggerFirst: false },
  ])(
    "keeps a payload failure open across trigger checks (threshold=$after, triggerFirst=$triggerFirst)",
    ({ after, triggerFirst }) => {
      const store = fixtures.makeStorePath();
      let now = Date.parse("2026-08-01T15:00:00Z");
      const job = createAlertJob({ id: "mixed-trigger-payload-incident", dueAt: now });
      const sendCronFailureAlert = vi.fn<SendCronFailureAlert>(async () => undefined);
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => now,
        sendCronFailureAlert,
      });
      const fail = (source: "trigger" | "payload", code: "timeout" | "plugin_reload_failed") =>
        applyJobResultAndDrainNotifications(state, job, {
          status: "error",
          error: "script failure",
          ...cronScriptFailureMetadata(source, code),
          startedAt: now,
          endedAt: now,
        });
      if (triggerFirst) {
        fail("trigger", "timeout");
      }
      job.failureAlert = { after, cooldownMs: 60_000 };
      now += 1_000;
      fail("payload", "timeout");
      expect(sendCronFailureAlert).toHaveBeenCalledTimes(triggerFirst ? 1 : 0);
      now += 60_000;
      fail("trigger", "plugin_reload_failed");
      const incidentAlerts = triggerFirst ? 2 : 1;
      expect(sendCronFailureAlert).toHaveBeenCalledTimes(incidentAlerts);
      applyTriggerNoFireResultAndDrainNotifications(state, job, {
        startedAt: now + 1_000,
        endedAt: now + 1_001,
        triggerEval: { fired: false, stateChanged: false },
      });
      expect(sendCronFailureAlert).toHaveBeenCalledTimes(incidentAlerts);
      expect(job.state.failureAlertIncident?.scope).toBe("run");
      applyJobResultAndDrainNotifications(state, job, {
        status: "ok",
        startedAt: now + 2_000,
        endedAt: now + 2_001,
      });
      expect(sendCronFailureAlert).toHaveBeenCalledTimes(incidentAlerts + 1);
      expect(sendCronFailureAlert.mock.calls[incidentAlerts]?.[0].payload.text).toContain(
        "recovered",
      );
    },
  );

  it.each(["trigger", "payload"] as const)(
    "clears an unreported %s failure after success without notifying",
    (source) => {
      const store = fixtures.makeStorePath();
      const now = Date.parse("2026-08-01T15:00:00Z");
      const job = createAlertJob({ id: "unreported-incident-recovery", dueAt: now });
      job.failureAlert = { after: 2 };
      const sendCronFailureAlert = vi.fn<SendCronFailureAlert>(async () => undefined);
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => now,
        sendCronFailureAlert,
      });
      applyJobResultAndDrainNotifications(state, job, {
        status: "error",
        error: "script failure",
        ...cronScriptFailureMetadata(source, "plugin_reload_failed"),
        startedAt: now,
        endedAt: now,
      });
      applyJobResultAndDrainNotifications(state, job, {
        status: "ok",
        startedAt: now + 1_000,
        endedAt: now + 1_001,
      });
      expect(sendCronFailureAlert).not.toHaveBeenCalled();
      expect(job.state.failureAlertIncident).toBeUndefined();
    },
  );
});
