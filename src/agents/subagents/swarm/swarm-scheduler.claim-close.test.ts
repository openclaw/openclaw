import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseByPathAsync,
} from "../../../state/openclaw-state-db-cache.js";
import { waitForQueuedSubagentClaim } from "../registry/subagent-registry-queued-registration-wait.js";
import { closeSwarmScheduler } from "./swarm-scheduler.js";
import {
  enqueueSwarmRun,
  observeSwarmSchedulerWork,
} from "./swarm-scheduler.lifecycle.test-support.js";

const wakes = vi.hoisted(() => new Set<() => void>());
vi.mock("../registry/subagent-registry-publication.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../registry/subagent-registry-publication.js")>();
  return {
    ...actual,
    subscribeSubagentRunChanges: ((phase, listener) => {
      if (phase === "projection") {
        return actual.subscribeSubagentRunChanges(phase, listener);
      }
      const wake = () => listener({ runIds: undefined, sessionKeys: undefined });
      wakes.add(wake);
      return () => wakes.delete(wake);
    }) satisfies typeof actual.subscribeSubagentRunChanges,
  };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let admission: ReturnType<typeof captureOpenClawStateDatabaseReadAdmission>;
let schedulerWork: ReturnType<typeof observeSwarmSchedulerWork>;

beforeEach(() => {
  schedulerWork = observeSwarmSchedulerWork();
  resetGatewayWorkAdmission();
  admission = captureOpenClawStateDatabaseReadAdmission(
    path.join(tempDirs.make("openclaw-swarm-claim-close-"), "state.sqlite"),
  );
});
afterEach(async () => {
  await schedulerWork.close();
  resetGatewayWorkAdmission();
  await closeOpenClawStateDatabaseByPathAsync(admission.databasePath);
  expect(wakes.size).toBe(0);
});

it.each(["start", "failure"] as const)(
  "closes a retained %s claim wait while joining physical work and fresh cleanup",
  async (phase) => {
    const lifecycleOwner = {};
    const entered = createDeferredCore();
    const physical = createDeferredCore();
    const cleanup = createDeferredCore();
    const tails: Promise<void>[] = [];
    let pendingClaim = true;
    const signals: Partial<Record<"waiting" | "failure" | "cleanup", AbortSignal>> = {};
    let closed = false;
    let closing: Promise<void> | undefined;
    const waitForClaim = () =>
      waitForQueuedSubagentClaim({
        admission,
        assertCurrent: admission.assertCurrent,
        pending: () => pendingClaim,
      });
    const retainPhysicalWork = () => {
      signals.waiting = getAsyncWorkSignal();
      tails.push(trackAsyncWork(() => physical.promise));
      entered.resolve();
    };
    enqueueSwarmRun({
      groupId: "claim-close",
      runId: "claimed",
      maxConcurrent: 1,
      activeRunIds: [],
      lifecycleOwner,
      start: async () => {
        if (phase === "failure") {
          throw new Error("dispatch refused");
        }
        retainPhysicalWork();
        await waitForClaim();
      },
      onStartFailure: async () => {
        signals.failure = getAsyncWorkSignal();
        if (phase === "failure") {
          retainPhysicalWork();
        }
        await waitForClaim().catch(() => {});
        return true;
      },
      onRemoved: async () => {
        signals.cleanup = getAsyncWorkSignal();
        await cleanup.promise;
      },
    });
    try {
      await entered.promise;
      closing = schedulerWork.close().then(() => {
        closed = true;
      });
      await nextTurn();
      expect(signals.waiting?.aborted).toBe(true);
      expect(pendingClaim).toBe(true);
      expect(closed).toBe(false);
      expect(signals).not.toHaveProperty("cleanup");
      physical.resolve();
      await nextTurn();
      expect(signals.failure?.aborted).toBe(true);
      expect(signals.cleanup).toMatchObject({ aborted: false });
      expect(closed).toBe(false);
      cleanup.resolve();
      await closing;
      expect(pendingClaim).toBe(true);
    } finally {
      pendingClaim = false;
      for (const wake of wakes) {
        wake();
      }
      physical.resolve();
      cleanup.resolve();
      await Promise.allSettled(tails);
      await closing;
      await closeSwarmScheduler(lifecycleOwner);
    }
  },
);
