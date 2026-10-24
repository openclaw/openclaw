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
import { runMissedJobs } from "./timer.test-support.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-startup-notifications-",
});

it.each([
  ["planning", "default", "original-agent"],
  ["planning", "absence", undefined],
  ["planning", "explicit agent", "explicit-owner"],
  ["planning", "session owner", "session-owner"],
  ["cleanup", "default", "original-agent"],
] as const)(
  "preserves startup %s auto-disable routing after a default change (%s)",
  async (phase, route, agentId) => {
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
    const storeKey = cronStoreKey(storePath);
    const database = openOpenClawStateDatabase().db;
    const readEnabled = () =>
      database
        .prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
        .get(storeKey, job.id)?.enabled;
    let currentDefault = route === "default" ? "original-agent" : undefined;
    const order: string[] = [];
    const enqueueSessionEvent = vi.fn(() => {
      expect(readEnabled()).toBe(0);
      order.push("notify");
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
      enqueueSessionEvent,
      runIsolatedAgentJob: runner,
    });
    state.deps.log = { ...state.deps.log, warn };
    const stopObserving = observeCronStoreCommits(storePath, () => {
      if (!order.includes("commit") && readEnabled() === 0) {
        order.push("commit");
        currentDefault = "replacement-agent";
      }
    });
    try {
      await expect(runMissedJobs(state)).resolves.toBeUndefined();
      const persisted = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
      expect(runner).not.toHaveBeenCalled();
      expect(readCronRunHistoryPageForTests({ storeKey, jobId: job.id }).entries).toEqual([]);
      expect(
        database
          .prepare("SELECT receipt_id FROM cron_run_receipts WHERE store_key = ? AND job_id = ?")
          .all(storeKey, job.id),
      ).toEqual([]);
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
        expect(enqueueSessionEvent).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          { error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE },
          "cron: post-persist notification failed",
        );
      } else {
        expect(order).toEqual(["commit", "notify"]);
        expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("was auto-disabled"),
          expect.objectContaining({
            agentId,
            sessionKey: job.sessionKey,
            contextKey: `cron:${job.id}:auto-disabled`,
          }),
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
