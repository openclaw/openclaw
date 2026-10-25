import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessionStores from "../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import * as targets from "../config/sessions/targets-runtime.js";
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

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
// Only diagnostics are replaced: scheduler, snapshot discovery and retention use their real owners.
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      return name === "cron/maintenance" ? { ...logger, ...logs } : logger;
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
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
    const stale: { sessionKey: string; storePath: string }[] = [];
    for (const agentId of ["main", "retired"]) {
      const scope = {
        sessionKey: `agent:${agentId}:cron:done-job:run:old`,
        storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
      };
      await replaceSessionEntry(scope, { sessionId: agentId, updatedAt: now - 8 * 86_400_000 });
      stale.push(scope);
    }
    const retiredPath = resolveSqliteTargetFromSessionStorePath(stale[1]!.storePath).path;
    // Inspect synthetic persisted bytes without trying to admit a deleted agent for runtime reads.
    const readRetired = () => {
      using database = new DatabaseSync(retiredPath, { readOnly: true });
      return database
        .prepare("SELECT entry_json, archived_at FROM session_nodes WHERE session_key = ?")
        .get(stale[1]!.sessionKey);
    };
    const retiredBefore = readRetired();
    expect(retiredBefore).toEqual({ entry_json: expect.any(String), archived_at: null });
    const running = {
      sessionKey: "agent:main:cron:live-job:run:old",
      storePath: stale[0]!.storePath,
    };
    await replaceSessionEntry(running, { sessionId: "live", updatedAt: now - 8 * 86_400_000 });
    const job = makeCronReceiptJob("live-job", "main");
    job.state.runningAtMs = now;
    await saveCronStore(cronStorePath, { version: 1, jobs: [job] });

    const discovered = createDeferredCore();
    const resume = createDeferredCore();
    const discover = targets.resolveAllAgentSessionStoreTargetsAsync;
    const discovery = vi.spyOn(targets, "resolveAllAgentSessionStoreTargetsAsync");
    if (change === "after healthy target") {
      const maintainStore = sessionStores.runSessionRegistryMaintenanceForStore;
      vi.spyOn(sessionStores, "runSessionRegistryMaintenanceForStore").mockImplementationOnce(
        async (...args) => {
          const result = await maintainStore(...args);
          discovered.resolve();
          await resume.promise;
          return result;
        },
      );
    } else {
      discovery.mockImplementationOnce(async (...args) => {
        const result = await discover(...args);
        discovered.resolve();
        await resume.promise;
        return result;
      });
    }
    let sweep: void | Promise<void> = undefined;
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
        const deletion = beginAgentDeletionJournal({
          agentId: "retired",
          operationId: "delete-retired",
          agentDir: state.agentDir("retired"),
          workspaceDir: state.path("retired-workspace"),
          sessionsDir: state.sessionsDir("retired"),
          deleteFiles: false,
        });
        if (change === "completed deletion") {
          runOpenClawStateWriteTransaction((database) =>
            completeAgentDeletionJournalInDatabase(
              database,
              deletion.agentId,
              deletion.operationId,
            ),
          );
        }
      }
      // Pending deletion exercises the fallback without receipts; the others coalesce a burst.
      if (change !== "pending deletion") {
        for (let receipt = 0; receipt < 3; receipt += 1) {
          sessionChanges.emit({
            sessionKey: "agent:main:cron:live-job:run:new",
            scope: "session-entry",
          });
        }
      }
      await clock.advanceBy(0);
      expect(discovery).toHaveBeenCalledOnce();
      resume.resolve();
      await sweep;
      // The per-target guard fires before the affected target, not an automatic consumer replay.
      if (change === "after healthy target") {
        expect(loadSessionEntry(stale[0]!)).toBeUndefined();
      } else {
        expect(loadSessionEntry(stale[0]!)).toBeDefined();
      }
      expect(readRetired()).toEqual(retiredBefore);
      expect(logs.warn).toHaveBeenCalledWith("Session registry maintenance deferred", {
        reason: "agent-database-snapshot-changed",
        retryAtMs: scheduler.nextWakeAtMs,
        lastSuccessAtMs: null,
      });
      expect(logs.warn).not.toHaveBeenCalledWith("Cron maintenance failed", expect.anything());
      expect(scheduler.nextWakeAtMs).not.toBeNull();
      expect(scheduler.nextWakeAtMs).toBeLessThanOrEqual(now + 65_000);
      if (change === "stop before retry") {
        await stopCronMaintenance();
        await clock.advanceBy(60_000);
        expect(discovery).toHaveBeenCalledOnce();
        expect(logs.info).not.toHaveBeenCalled();
        expect(loadSessionEntry(stale[0]!)).toBeDefined();
        expect(readRetired()).toEqual(retiredBefore);
        return;
      }
      await clock.advanceTo(scheduler.nextWakeAtMs!);
      expect(discovery).toHaveBeenCalledTimes(2);
      expect(loadSessionEntry(stale[0]!)).toBeUndefined();
      if (change === "registration removal") {
        expect(loadSessionEntry(stale[1]!)).toBeUndefined();
      } else {
        expect(readRetired()).toEqual(retiredBefore);
      }
      expect(loadSessionEntry(running)).toBeDefined();
      expect(logs.info).toHaveBeenCalledWith("Session registry maintenance completed", {
        lastSuccessAtMs: clock.clock.now(),
        nextSweepAtMs: scheduler.nextWakeAtMs,
        pruned: change === "registration removal" ? 2 : change === "after healthy target" ? 0 : 1,
        skippedStores: change === "registration removal" ? 0 : 1,
      });
      await stopCronMaintenance();
      const attempts = discovery.mock.calls.length;
      sessionChanges.emit({ all: true, scope: { agentId: "main", topology: true } });
      await clock.advanceBy(60_000);
      expect(discovery).toHaveBeenCalledTimes(attempts);
    } finally {
      resume.resolve();
      await sweep;
      await stopCronMaintenance();
      await scheduler.stop();
    }
  });
});
