import { expect, it, vi } from "vitest";
import { observeCronStoreCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { stop } from "./ops-lifecycle.js";
import { runMissedJobs } from "./timer.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-startup-notifications-",
});

it.each([
  { phase: "planning", route: "default" },
  { phase: "planning", route: "absence" },
  { phase: "planning", route: "explicit agent" },
  { phase: "planning", route: "session owner" },
  { phase: "cleanup", route: "default" },
] as const)(
  "preserves startup $phase auto-disable routing when the default changes after commit ($route)",
  async ({ phase, route }) => {
    const { storePath } = opsRegressionFixtures.makeStorePath();
    const now = Date.now();
    const job = createDueIsolatedJob({
      id: "startup-notice-route",
      nowMs: now,
      nextRunAtMs: now,
    });
    if (phase === "planning") {
      job.schedule = { kind: "cron", expr: "invalid" };
      job.state.scheduleErrorCount = 2;
    }
    if (route === "explicit agent") {
      job.agentId = "explicit-owner";
    } else if (route === "session owner") {
      job.sessionKey = "agent:session-owner:main";
    }
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const database = openOpenClawStateDatabase().db;
    const readEnabled = () =>
      database
        .prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
        .get(cronStoreKey(storePath), job.id)?.enabled;
    let currentDefault = route === "default" ? "original-agent" : undefined;
    let committed = false;
    const order: string[] = [];
    const enqueueSystemEvent = vi.fn(() => {
      expect(readEnabled()).toBe(0);
      order.push("notify");
    });
    const requestHeartbeat = vi.fn(() => {
      expect(order.at(-1)).toBe("notify");
      order.push("heartbeat");
    });
    const warn = vi.fn();
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const resolveDefaultAgentId = vi.fn(() => {
      if (route === "explicit agent" || route === "session owner") {
        throw new Error("explicit notice owner must not consult the default");
      }
      return currentDefault;
    });
    const state = createCronRegressionState({
      storePath,
      nowMs: () => now,
      resolveDefaultAgentId,
      cronConfig: { skipMissedJobs: phase === "planning" },
      maxMissedJobsPerRestart: 0,
      // Exercise the actual startup-settlement auto-disable producer on Date overflow.
      missedJobStaggerMs: Number.MAX_SAFE_INTEGER,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: runner,
    });
    state.deps.defaultAgentId = undefined;
    state.deps.log = { ...state.deps.log, warn };
    const stopObserving = observeCronStoreCommits(storePath, () => {
      if (!committed && readEnabled() === 0) {
        committed = true;
        order.push("commit");
        currentDefault = "replacement-agent";
      }
    });
    try {
      const outcome = await runMissedJobs(state).then(
        () => ({ kind: "completed" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      const persistedStore = await loadCronStore(storePath);
      const persisted = persistedStore.jobs.find((entry) => entry.id === job.id);
      expect(runner).not.toHaveBeenCalled();
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
          .entries,
      ).toEqual([]);
      expect(
        database
          .prepare("SELECT receipt_id FROM cron_run_receipts WHERE store_key = ? AND job_id = ?")
          .all(cronStoreKey(storePath), job.id),
      ).toEqual([]);
      expect(state.startupCatchup).toBeUndefined();
      expect(outcome).toEqual({ kind: "completed" });
      expect(committed).toBe(true);
      expect(persisted).toMatchObject({
        enabled: false,
        schedule: job.schedule,
        payload: job.payload,
        state: {
          autoDisabled: {
            reason: "schedule-errors",
            atMs: now,
            consecutiveErrors: phase === "planning" ? 3 : 1,
          },
        },
      });
      expect(persisted?.state.scheduleErrorCount).toBe(phase === "planning" ? 3 : undefined);
      expect(persisted?.state.nextRunAtMs).toBeUndefined();
      expect(persisted?.state.startupCatchupAtMs).toBeUndefined();
      expect(persisted?.state.queuedAtMs).toBeUndefined();
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(state.store?.jobs.find((entry) => entry.id === job.id)?.enabled).toBe(false);
      if (route === "absence") {
        expect(order).toEqual(["commit"]);
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          { error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE },
          "cron: post-persist notification failed",
        );
      } else {
        const agentId =
          route === "explicit agent"
            ? "explicit-owner"
            : route === "session owner"
              ? "session-owner"
              : "original-agent";
        expect(order).toEqual(["commit", "notify", "heartbeat"]);
        expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("was auto-disabled"),
          expect.objectContaining({
            agentId,
            sessionKey: job.sessionKey,
            contextKey: `cron:${job.id}:auto-disabled`,
          }),
        );
        expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ agentId, sessionKey: job.sessionKey, intent: "immediate" }),
        );
        if (route !== "default") {
          expect(resolveDefaultAgentId).not.toHaveBeenCalled();
        }
      }
    } finally {
      stopObserving();
      stop(state);
      await state.op;
    }
  },
);
