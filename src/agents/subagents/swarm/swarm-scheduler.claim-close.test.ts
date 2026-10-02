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
import { activateSwarmRun, closeSwarmScheduler, reserveSwarmRun } from "./swarm-scheduler.js";
import { testing } from "./swarm-scheduler.test-support.js";

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

beforeEach(() => {
  resetGatewayWorkAdmission();
  admission = captureOpenClawStateDatabaseReadAdmission(
    path.join(tempDirs.make("openclaw-swarm-claim-close-"), "state.sqlite"),
  );
});
afterEach(async () => {
  testing.reset();
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
    let waitingSignal: AbortSignal | undefined;
    let failureSignal: AbortSignal | undefined;
    let cleanupSignal: AbortSignal | undefined;
    let cleanupEntered = false;
    let closed = false;
    let closing: Promise<void> | undefined;
    const waitForClaim = () =>
      waitForQueuedSubagentClaim({
        admission,
        assertCurrent: admission.assertCurrent,
        pending: () => pendingClaim,
      });
    const retainPhysicalWork = () => {
      waitingSignal = getAsyncWorkSignal();
      tails.push(trackAsyncWork(() => physical.promise));
      entered.resolve();
    };
    reserveSwarmRun({
      groupId: "claim-close",
      runId: "claimed",
      maxConcurrent: 1,
      activeRunIds: [],
    });
    activateSwarmRun({
      groupId: "claim-close",
      runId: "claimed",
      lifecycleOwner,
      start: async () => {
        if (phase === "failure") {
          throw new Error("dispatch refused");
        }
        retainPhysicalWork();
        await waitForClaim();
      },
      onStartFailure: async () => {
        failureSignal = getAsyncWorkSignal();
        if (phase === "failure") {
          retainPhysicalWork();
        }
        await waitForClaim().catch(() => {});
        return true;
      },
      onRemoved: async () => {
        cleanupEntered = true;
        cleanupSignal = getAsyncWorkSignal();
        await cleanup.promise;
      },
    });
    try {
      await entered.promise;
      closing = closeSwarmScheduler(lifecycleOwner).then(() => {
        closed = true;
      });
      await nextTurn();
      expect(waitingSignal?.aborted).toBe(true);
      expect(pendingClaim).toBe(true);
      expect(closed).toBe(false);
      expect(cleanupEntered).toBe(false);
      physical.resolve();
      await nextTurn();
      expect(failureSignal?.aborted).toBe(true);
      expect(cleanupEntered).toBe(true);
      expect(cleanupSignal).toBeDefined();
      expect(cleanupSignal?.aborted).toBe(false);
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
