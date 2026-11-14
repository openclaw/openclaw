import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessionStores from "../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import * as targets from "../config/sessions/targets-runtime.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { startCronMaintenance, stopCronMaintenance } from "./maintenance.js";
import { saveCronStore } from "./store.js";
import { makeCronReceiptJob } from "./store/run-receipt-store.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetConfigRuntimeState();
  resetGatewayWorkAdmission();
});

it.each([
  "pending deletion",
  "completed deletion",
  "registration removal",
  "after healthy target",
  "stop before retry",
])("handles snapshot invalidation: %s through the real maintenance scheduler", async (change) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    resetGatewayWorkAdmission();
    setRuntimeConfigSnapshot({});
    const now = Date.now();
    const clock = createGatewaySchedulerClock(now);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const cronStorePath = state.statePath("selected-cron/jobs.json");
    const seedSession = async (agentId: string, jobId = "done-job", sessionId = agentId) => {
      const scope = {
        sessionKey: `agent:${agentId}:cron:${jobId}:run:old`,
        storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
      };
      await replaceSessionEntry(scope, { sessionId, updatedAt: now - 8 * 86_400_000 });
      return scope;
    };
    const healthy = await seedSession("main");
    const retired = await seedSession("retired");
    const retiredPath = resolveSqliteTargetFromSessionStorePath(retired.storePath).path;
    // Inspect synthetic persisted bytes without trying to admit a deleted agent for runtime reads.
    const readRetired = () => {
      using database = new DatabaseSync(retiredPath, { readOnly: true });
      return database
        .prepare("SELECT entry_json, archived_at FROM session_nodes WHERE session_key = ?")
        .get(retired.sessionKey);
    };
    const retiredBefore = readRetired();
    expect(retiredBefore).toEqual({ entry_json: expect.any(String), archived_at: null });
    const running = await seedSession("main", "live-job", "live");
    const job = makeCronReceiptJob("live-job", "main");
    job.state.runningAtMs = now;
    await saveCronStore(cronStorePath, { version: 1, jobs: [job] });

    const discovered = createDeferredCore();
    const resume = createDeferredCore();
    const discover = targets.resolveAllAgentSessionStoreTargetsAsync;
    const discovery = vi.spyOn(targets, "resolveAllAgentSessionStoreTargetsAsync");
    const pauseAfter = async <T>(result: Promise<T>): Promise<T> => {
      const value = await result;
      discovered.resolve();
      await resume.promise;
      return value;
    };
    if (change === "after healthy target") {
      const maintainStore = sessionStores.runSessionRegistryMaintenanceForStore;
      vi.spyOn(sessionStores, "runSessionRegistryMaintenanceForStore").mockImplementationOnce(
        (...args) => pauseAfter(maintainStore(...args)),
      );
    } else {
      discovery.mockImplementationOnce((...args) => pauseAfter(discover(...args)));
    }
    let sweep: void | Promise<void> = undefined;
    const logs = createWarnLogCapture("cron-maintenance-snapshot");
    try {
      startCronMaintenance(scheduler, () => cronStorePath);
      sweep = clock.advanceBy(5_000);
      await discovered.promise;
      if (change === "registration removal") {
        unregisterOpenClawAgentDatabase({
          agentId: "retired",
          path: retiredPath,
          env: state.env,
        });
      } else {
        beginAgentDeletionJournal({
          agentId: "retired",
          operationId: "delete-retired",
          agentDir: state.agentDir("retired"),
          workspaceDir: state.path("retired-workspace"),
          sessionsDir: state.sessionsDir("retired"),
          deleteFiles: false,
        });
        if (change === "completed deletion") {
          runOpenClawStateWriteTransaction((database) =>
            completeAgentDeletionJournalInDatabase(database, "retired", "delete-retired"),
          );
        }
      }
      resume.resolve();
      await sweep;
      // The per-target guard fires before the affected target, not an automatic consumer replay.
      expect(loadSessionEntry(healthy) === undefined).toBe(change === "after healthy target");
      expect(readRetired()).toEqual(retiredBefore);
      expect(await logs.findText("Session registry maintenance deferred")).toBeDefined();
      expect(await logs.findText("agent-database-snapshot-changed")).toBeDefined();
      expect(await logs.findText("Cron maintenance failed")).toBeUndefined();
      expect(scheduler.nextWakeAtMs).not.toBeNull();
      expect(scheduler.nextWakeAtMs).toBeLessThanOrEqual(now + 65_000);
      if (change === "stop before retry") {
        await stopCronMaintenance();
        sessionChanges.emit({ all: true, scope: { agentId: "main", topology: true } });
        await clock.advanceBy(60_000);
        expect(discovery).toHaveBeenCalledOnce();
        expect(loadSessionEntry(healthy)).toBeDefined();
        expect(readRetired()).toEqual(retiredBefore);
        return;
      }
      await clock.advanceTo(scheduler.nextWakeAtMs!);
      expect(loadSessionEntry(healthy)).toBeUndefined();
      if (change === "registration removal") {
        expect(loadSessionEntry(retired)).toBeUndefined();
      } else {
        expect(readRetired()).toEqual(retiredBefore);
      }
      expect(loadSessionEntry(running)).toBeDefined();
    } finally {
      resume.resolve();
      await sweep;
      await stopCronMaintenance();
      await scheduler.stop();
      logs.cleanup();
    }
  });
});
