import { describe, expect, it, vi } from "vitest";
import { setupCronRegressionFixtures } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronFailureNotificationDelivery } from "../types.js";
import {
  createAlertJob,
  createAlertState,
  finalizeAlertOutcome,
  type SendCronFailureAlert,
} from "./failure-alerts.test-support.js";
import { stop as stopCronService } from "./ops-lifecycle.js";

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
    return { store, state };
  }

  it.each([
    {
      name: "delivered",
      outcome: { delivered: true, status: "delivered" },
    },
    {
      name: "not delivered",
      outcome: {
        delivered: false,
        status: "not-delivered",
        error: "alert channel exploded",
      },
    },
    {
      name: "unknown",
      outcome: { status: "unknown", error: "later delivery work failed" },
    },
  ] satisfies Array<{ name: string; outcome: CronFailureNotificationDelivery }>)(
    "persists a $name outcome in the worker once the send settles",
    async ({ name, outcome }) => {
      const settled = createDeferred();
      let hostStatements = 0;
      const { store } = await runFailure({
        id: `alert-outcome-${name.replaceAll(" ", "-")}`,
        sendCronFailureAlert: vi.fn(async (params) => {
          const statements = observeHostDataSql();
          try {
            await params.onDeliverySettled(outcome);
            hostStatements = statements.calls.reduce(
              (sum, call) => sum + call.mock.calls.length,
              0,
            );
            settled.resolve();
          } catch (error) {
            settled.reject(error);
            throw error;
          } finally {
            statements.restore();
          }
        }),
      });

      await settled.promise;
      expect(hostStatements).toBe(0);
      expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
        lastFailureAlertAtMs: endedAt,
        lastFailureNotificationDeliveryStatus: outcome.status,
      });
      const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state;
      expect(persisted?.lastFailureNotificationDelivered).toBe(outcome.delivered);
      expect(persisted?.lastFailureNotificationDeliveryError).toBe(outcome.error);
    },
  );

  it("redacts transport errors before persisting them", async () => {
    const err = new Error(
      `webhook rejected: token=abcdefghijklmnopqrstuvwxyz123456 ${"x".repeat(2_000)}`,
    );
    const send = vi.fn<SendCronFailureAlert>(async (params) => {
      await params.onDeliverySettled({
        delivered: false,
        status: "not-delivered",
        error: err.message,
      });
    });
    const { store } = await runFailure({
      id: "alert-outcome-redacted-error",
      sendCronFailureAlert: send,
    });
    expect(send).toHaveBeenCalledOnce();
    await send.mock.results[0]?.value;
    expect(
      (await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureNotificationDeliveryStatus,
    ).toBe("not-delivered");
    const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state
      .lastFailureNotificationDeliveryError;
    expect(persisted).toHaveLength(1_000);
    expect(formatErrorMessage(err).length).toBeGreaterThan(1_000);
    expect(persisted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("does not overwrite a newer alert cycle committed by a sibling service", async () => {
    const store = fixtures.makeStorePath();
    const job = createAlertJob({ id: "alert-outcome-sibling-cycle", dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    // Service A: the send stays in flight while a sibling commits a newer cycle.
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const sendA = vi.fn(async (params) => {
      await gateA;
      await params.onDeliverySettled({ delivered: true, status: "delivered" });
    });
    const stateA = createAlertState({
      storePath: store.storePath,
      nowMs: () => endedAt,
      sendCronFailureAlert: sendA,
    });
    await finalizeAlertOutcome({
      state: stateA,
      job,
      status: "error",
      error: "provider unavailable",
      startedAt: dueAt,
      endedAt,
    });

    // Service B on the same store: a later failure past the cooldown starts a
    // newer alert cycle and commits it.
    const laterAt = endedAt + 600_000;
    const sendB = vi.fn(async (params) => {
      await params.onDeliverySettled({
        delivered: false,
        status: "not-delivered",
        error: "recipient not reached",
      });
    });
    const stateB = createAlertState({
      storePath: store.storePath,
      nowMs: () => laterAt,
      sendCronFailureAlert: sendB,
    });
    const jobForB = structuredClone(job);
    jobForB.state.runningAtMs = laterAt;
    await finalizeAlertOutcome({
      state: stateB,
      job: jobForB,
      status: "error",
      error: "provider unavailable again",
      startedAt: laterAt - 10,
      endedAt: laterAt,
    });
    expect(sendB).toHaveBeenCalledOnce();
    await sendB.mock.results[0]?.value;
    expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureAlertAtMs).toBe(
      laterAt,
    );

    // Service A's delayed send settles with a stale snapshot; it must not
    // overwrite the sibling's newer cycle.
    releaseA?.();
    await sendA.mock.results[0]?.value;
    await Promise.resolve();
    await stateA.op;
    await Promise.resolve();
    await stateA.op;

    const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state;
    expect(persisted?.lastFailureAlertAtMs).toBe(laterAt);
    expect(persisted?.lastFailureNotificationDelivered).not.toBe(true);
  });

  it("restores the live fields when the outcome persist fails", async () => {
    const store = fixtures.makeStorePath();
    const job = createAlertJob({ id: "alert-outcome-persist-restore", dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    let releaseSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendCronFailureAlert = vi.fn(async (params) => {
      await sendGate;
      await params.onDeliverySettled({ delivered: false, status: "not-delivered" });
    });
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => endedAt,
      sendCronFailureAlert,
    });
    await finalizeAlertOutcome({
      state,
      job,
      status: "error",
      error: "provider unavailable",
      startedAt: dueAt,
      endedAt,
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
      releaseSend?.();
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

  it("does not overwrite a newer run in the same alert cooldown cycle", async () => {
    let resolveSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const sendCronFailureAlert = vi.fn(async (params) => {
      await sendGate;
      await params.onDeliverySettled({ delivered: false, status: "not-delivered" });
    });
    const { store, state } = await runFailure({
      id: "alert-outcome-same-cycle-newer-run",
      sendCronFailureAlert,
    });
    const currentJob = state.store?.jobs[0];
    if (!currentJob) {
      throw new Error("expected persisted cron job");
    }
    const laterAt = endedAt + 1_000;
    currentJob.state.runningAtMs = laterAt;
    await finalizeAlertOutcome({
      state,
      job: currentJob,
      status: "error",
      error: "provider still unavailable",
      startedAt: laterAt,
      endedAt: laterAt + 10,
    });
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();

    resolveSend?.();
    await sendCronFailureAlert.mock.results[0]?.value;
    const durable = (await loadCronStore(store.storePath)).jobs[0]?.state;
    expect(durable).toMatchObject({
      lastRunAtMs: laterAt,
      lastFailureAlertAtMs: endedAt,
      lastFailureNotificationDeliveryStatus: "not-requested",
    });
    expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("does not write after the service lifecycle retires", async () => {
    let resolveSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const sendCronFailureAlert = vi.fn(async (params) => {
      await sendGate;
      await params.onDeliverySettled({ delivered: false, status: "not-delivered" });
    });
    const { store, state } = await runFailure({
      id: "alert-outcome-retired-lifecycle",
      sendCronFailureAlert,
    });

    stopCronService(state);
    resolveSend?.();
    await sendCronFailureAlert.mock.results[0]?.value;

    expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
      lastFailureNotificationDeliveryStatus: "unknown",
    });
    expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
