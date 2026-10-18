import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  beginGatewayRestartSignalAdmission,
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "../../state/agent-database-admission-error.js";
import {
  assertAgentDatabaseResourceAdmission,
  withAgentDatabaseCloseFence,
} from "../../state/openclaw-agent-db-resources.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, FollowupRunDeferredError, scheduleFollowupDrain } from "./queue.js";
import {
  createQueueTestRun as createRun,
  createDrainRecorder,
  createQueueSettings,
  clearFollowupQueueForTest,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { clearFollowupDrainCallback, kickFollowupDrainIfIdle } from "./queue/drain.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/recent-message-ids.test-support.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";

installQueueRuntimeErrorSilencer();
const defaults: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
let sequence = 0;
let key: string;
beforeEach(() => {
  resetGatewayWorkAdmission();
  key = `drain-restart-${++sequence}`;
});
afterEach(() => {
  vi.useRealTimers();
  clearFollowupQueueForTest(key);
  resetGatewayWorkAdmission();
});
const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function start(prompt: string, run: (run: FollowupRun) => Promise<void>, settings = defaults) {
  enqueue(prompt, settings);
  scheduleFollowupDrain(key, run);
}
function enqueue(prompt: string, settings = defaults) {
  enqueueFollowupRun(key, createRun({ prompt }), settings);
}
const queuedState = () => getExistingFollowupQueue(key);
const waitForRoots = (count = 0) =>
  vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(count));

function restartAttempt(fenced: boolean) {
  const refused =
    createDeferred<NonNullable<ReturnType<typeof beginGatewayRestartSignalAdmission>>>();
  const delivered = createDeferred();
  let attempts = 0;
  return {
    refused,
    delivered,
    attempts: () => attempts,
    run: async () => {
      if (++attempts === 1) {
        if (fenced) {
          const fence = beginGatewayRestartSignalAdmission();
          if (!fence) {
            throw new Error("expected restart-signal fence");
          }
          refused.resolve(fence);
        }
        throw new GatewayDrainingError();
      }
      delivered.resolve();
    },
  };
}

it.each([
  { callback: "same", stillClosed: false },
  { callback: "fresh", stillClosed: false },
  { callback: "same", stillClosed: true },
  { callback: "fresh", stillClosed: true },
] as const)(
  "honors a $callback callback's drain request while an attempt unwinds (still closed: $stillClosed)",
  async ({ callback, stillClosed }) => {
    vi.useFakeTimers();
    const refused = createDeferred();
    const release = createDeferred();
    const delivered = vi.fn();
    let attempts = 0;
    const retry = async (run: FollowupRun) => {
      // Stop a broken wake consumer before it can starve the fake clock.
      if (attempts > 2) {
        clearFollowupQueue(key);
        return;
      }
      if (stillClosed) {
        throw new AgentDatabaseExecutionAdmissionClosedError("database is still closing");
      }
      delivered(run);
    };
    const runFollowup = async (run: FollowupRun) => {
      if (++attempts > 1) {
        return retry(run);
      }
      refused.resolve();
      await release.promise;
      throw new AgentDatabaseExecutionAdmissionClosedError("retired database owner");
    };
    const queued = createRun({ prompt: "resume after the explicit wake" });
    try {
      enqueueFollowupRun(key, queued, defaults);
      scheduleFollowupDrain(key, runFollowup);
      await refused.promise;
      scheduleFollowupDrain(
        key,
        callback === "same"
          ? runFollowup
          : async (run) => {
              attempts += 1;
              await retry(run);
            },
      );
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(2);
      if (stillClosed) {
        expect(delivered).not.toHaveBeenCalled();
        expect(queuedState()).toMatchObject({ items: [queued], draining: false });
      } else {
        expect(delivered).toHaveBeenCalledExactlyOnceWith(queued);
        expect(queuedState()).toBeUndefined();
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      release.resolve();
    }
  },
);

it("parks queued input when database admission closes until a fresh drain is requested", async () => {
  vi.useFakeTimers();
  const target = { agentId: "main", path: "/synthetic/followup-drain/agent.sqlite" };
  const queued = createRun({ prompt: "retain for recovery" });
  const settled = vi.fn();
  queued.turnAdoptionLifecycle = { onAdopted: async () => {}, onSettled: settled };
  let attempts = 0;
  let closing = true;
  const runFollowup = async () => {
    attempts += 1;
    // Bound the broken implementation so the regression cannot starve Vitest.
    if (closing && attempts > 1) {
      clearFollowupQueue(key);
    }
    assertAgentDatabaseResourceAdmission(target);
  };
  await withAgentDatabaseCloseFence(target, async () => {
    enqueueFollowupRun(key, queued, defaults);
    scheduleFollowupDrain(key, runFollowup);
    await vi.advanceTimersByTimeAsync(0);

    expect(attempts).toBe(1);
    expect(queuedState()).toMatchObject({ items: [queued], draining: false });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(settled).not.toHaveBeenCalled();
  });
  closing = false;
  kickFollowupDrainIfIdle(key);
  await vi.advanceTimersByTimeAsync(0);
  expect(attempts).toBe(2);
  expect(queuedState()).toBeUndefined();
});

it("keeps a detached drain on a live root after its enqueue request returns", async () => {
  const parentReleased = createDeferred();
  const drained = createDeferred();
  const parent = tryBeginGatewayRootWorkAdmission();
  if (!parent) {
    throw new Error("expected parent Gateway work admission");
  }
  let observed: unknown;
  const predecessorGeneration = {
    remoteCatalog: null,
    configuredCatalogEntries: [],
    inlineProviderModels: [],
    pluginMetadataSnapshot: {} as never,
  };
  try {
    await withPreparedModelRuntimePluginGenerationScope(predecessorGeneration, () =>
      parent.run(async () => {
        expect(getPreparedModelRuntimePluginGeneration()).toBe(predecessorGeneration);
        start("detached", async () => {
          await parentReleased.promise;
          const suspension = tryBeginGatewaySuspendAdmission(() => {});
          try {
            observed = {
              suspension: suspension !== null,
              generation: getPreparedModelRuntimePluginGeneration(),
              closed: isGatewaySubordinateWorkAdmissionClosed(),
              roots: getActiveGatewayRootWorkCount(),
            };
          } finally {
            suspension?.rollback();
            drained.resolve();
          }
        });
      }),
    );

    parent.release();
    parentReleased.resolve();
    await drained.promise;

    expect(observed).toEqual({
      suspension: true,
      generation: undefined,
      closed: false,
      roots: 1,
    });
    await waitForRoots();
  } finally {
    parent.release();
    parentReleased.resolve();
  }
});

it("releases a detached drain root when its queue is cleared during debounce", async () => {
  const env = captureEnv(["OPENCLAW_TEST_FAST"]);
  setTestEnvValue("OPENCLAW_TEST_FAST", "0");
  try {
    start("clear during debounce", async () => {}, { ...defaults, debounceMs: 60_000 });
    await waitForRoots(1);

    clearFollowupQueueForTest(key);

    await waitForRoots();
  } finally {
    clearFollowupQueueForTest(key);
    env.restore();
  }
});

it("does not retain stale callbacks when scheduleFollowupDrain runs with an empty queue", async () => {
  const stale = createDrainRecorder();
  const fresh = createDrainRecorder();
  scheduleFollowupDrain(key, stale.runFollowup);
  enqueue("after-empty-schedule");
  await nextTurn();
  expect(stale.calls).toHaveLength(0);
  scheduleFollowupDrain(key, fresh.runFollowup);
  await fresh.done.promise;
  expect(stale.calls).toHaveLength(0);
  expect(fresh.calls.map((run) => run.prompt)).toEqual(["after-empty-schedule"]);
});

it("restarts an idle drain across distinct enqueue and drain module instances when enqueue refreshes the callback", async () => {
  const drainA = await importFreshModule<typeof import("./queue/drain.js")>(
    import.meta.url,
    "./queue/drain.js?scope=restart-a",
  );
  const enqueueB = await importFreshModule<typeof import("./queue/enqueue.js")>(
    import.meta.url,
    "./queue/enqueue.js?scope=restart-b",
  );
  const recorder = createDrainRecorder();
  resetRecentQueuedMessageIdDedupe();
  try {
    enqueueB.enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), defaults);
    drainA.scheduleFollowupDrain(key, recorder.runFollowup);
    await recorder.done.promise;
    await nextTurn();
    enqueueB.enqueueFollowupRun(
      key,
      createRun({ prompt: "after-idle" }),
      defaults,
      "message-id",
      recorder.runFollowup,
    );
    await vi.waitFor(() => expect(recorder.calls).toHaveLength(2), { timeout: 1_000 });
    expect(recorder.calls.map((run) => run.prompt)).toEqual(["before-idle", "after-idle"]);
  } finally {
    clearFollowupQueue(key);
    drainA.clearFollowupDrainCallback(key);
    resetRecentQueuedMessageIdDedupe();
  }
});

it.each(["open", "commit", "rollback"] as const)(
  "handles a draining error while restart admission is %s",
  async (mode) => {
    const attempt = restartAttempt(mode !== "open");
    start("restart input", attempt.run);
    if (mode !== "open") {
      const signal = await attempt.refused.promise;
      if (mode === "commit") {
        markGatewayRestartDraining();
      } else {
        await nextTurn();
        expect(attempt.attempts()).toBe(1);
        expect(queuedState()?.items).toHaveLength(1);
        expect(signal.rollback()).toBe(true);
        await waitForRoots();
        expect(attempt.attempts()).toBe(1);
        expect(queuedState()?.draining).toBe(false);
        kickFollowupDrainIfIdle(key);
      }
    }
    if (mode !== "commit") {
      await attempt.delivered.promise;
    }
    await waitForRoots();
    expect(attempt.attempts()).toBe(mode === "commit" ? 1 : 2);
    expect(queuedState()).toBeUndefined();
  },
);

it("refreshes the callback used by a deferred active-drain retry", async () => {
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const fresh = createDrainRecorder();
  const stale = vi.fn(async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
    throw new FollowupRunDeferredError("reply lane busy");
  });
  start("wait-for-lane", stale);
  await firstStarted.promise;
  scheduleFollowupDrain(key, fresh.runFollowup);
  releaseFirst.resolve();
  await fresh.done.promise;
  expect(stale).toHaveBeenCalledOnce();
  expect(fresh.calls).toMatchObject([{ prompt: "wait-for-lane" }]);
});

it("bounds overflow identities across repeated deferred retries", async () => {
  const settings = createQueueSettings({ mode: "followup", cap: 1 });
  const completed = createDeferred();
  let retainedIdentityCount = 0;
  let attempts = 0;

  const runFollowup = async () => {
    attempts += 1;
    if (attempts === 3) {
      const queue = getExistingFollowupQueue(key);
      retainedIdentityCount =
        queue?.summaryElisions.reduce((count, entry) => count + entry.sources.length, 0) ?? 0;
      clearFollowupQueue(key);
      completed.resolve();
      return;
    }
    if (attempts <= 2) {
      enqueueFollowupRun(key, createRun({ prompt: `dropped on retry ${attempts}` }), settings);
      enqueueFollowupRun(key, createRun({ prompt: `kept on retry ${attempts}` }), settings);
      throw new FollowupRunDeferredError("reply lane busy");
    }
  };

  enqueueFollowupRun(key, createRun({ prompt: "original dropped" }), settings);
  enqueueFollowupRun(key, createRun({ prompt: "original kept" }), settings);
  scheduleFollowupDrain(key, runFollowup);
  await completed.promise;

  expect(attempts).toBe(3);
  expect(retainedIdentityCount).toBeLessThanOrEqual(2);
});

it.each(["old", "new"] as const)(
  "drains a pending overflow summary after future drops switch to %s",
  async (dropPolicy) => {
    const summarizeSettings = createQueueSettings({ mode: "followup", cap: 1 });
    const nonOutcomeAbandoned = vi.fn();
    const nonOutcomeDisposition = vi.fn();
    const nonOutcomeSettled = vi.fn();
    const first = createRun({ prompt: "first" });
    const second = createRun({ prompt: "second" });
    const third = createRun({ prompt: "third" });
    Object.assign(dropPolicy === "old" ? second : third, {
      onQueueDisposition: nonOutcomeDisposition,
      turnAdoptionLifecycle: {
        admission: "cancel-only",
        onAdopted: vi.fn(),
        onAbandoned: nonOutcomeAbandoned,
        onSettled: nonOutcomeSettled,
      },
    } satisfies Partial<FollowupRun>);
    const deliveredPrompts: string[] = [];
    let forcedCleanup = false;
    let timerFired = false;

    expect(enqueueFollowupRun(key, first, summarizeSettings)).toBe(true);
    expect(enqueueFollowupRun(key, second, summarizeSettings)).toBe(true);
    const queue = getExistingFollowupQueue(key);
    const summary = { droppedCount: 1, summaryLines: ["first"] };
    expect(queue).toMatchObject({ ...summary, dropPolicy: "summarize" });
    expect(queue?.summarySources).toEqual([first]);
    expect(queue?.items).toEqual([second]);

    const admitted = enqueueFollowupRun(key, third, {
      ...summarizeSettings,
      dropPolicy,
    });
    expect(admitted).toBe(dropPolicy === "old");
    expect(getExistingFollowupQueue(key)).toBe(queue);
    expect(queue).toMatchObject({ ...summary, dropPolicy });
    expect(queue?.summarySources).toEqual([first]);
    expect(queue?.items).toEqual([dropPolicy === "old" ? third : second]);

    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });
    scheduleFollowupDrain(key, async (run) => {
      deliveredPrompts.push(run.prompt);
    });

    for (let pass = 0; pass < 2_000 && getExistingFollowupQueue(key); pass += 1) {
      await Promise.resolve();
    }
    if (getExistingFollowupQueue(key)) {
      forcedCleanup = true;
      clearFollowupQueue(key);
      clearFollowupDrainCallback(key);
    }
    await timer;
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(forcedCleanup).toBe(false);
    expect(timerFired).toBe(true);
    expect(deliveredPrompts).toHaveLength(2);
    expect(deliveredPrompts[0]).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(deliveredPrompts[0]).toContain("first");
    expect(deliveredPrompts[1]).toBe(dropPolicy === "old" ? "third" : "second");
    expect(nonOutcomeDisposition).toHaveBeenCalledWith(`queue-cap-${dropPolicy}`);
    expect(nonOutcomeAbandoned).toHaveBeenCalledOnce();
    expect(nonOutcomeSettled).toHaveBeenCalledTimes(1);
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  },
);

it("retires queued followups and callbacks when one-way restart drain begins", async () => {
  const abandoned = vi.fn();
  const settled = vi.fn();
  const stale = vi.fn(async () => {});
  const queued = createRun({ prompt: "retire on lifecycle restart" });
  queued.turnAdoptionLifecycle = {
    admission: "cancel-only",
    onAdopted: async () => {},
    onAbandoned: abandoned,
    onSettled: settled,
  };

  enqueueFollowupRun(key, queued, defaults, "message-id", stale, false);
  expect(queuedState()?.items).toEqual([queued]);

  markGatewayRestartDraining();

  expect(queuedState()).toBeUndefined();
  expect(abandoned).toHaveBeenCalledOnce();
  expect(settled).toHaveBeenCalledOnce();
  resetGatewayWorkAdmission();
  enqueue("fresh lifecycle");
  await nextTurn();
  expect(stale).not.toHaveBeenCalled();
  expect(queuedState()?.items).toHaveLength(1);
});
it.each([
  { mode: "collect", kind: "external_user", senderIsOwner: true, owner: true },
  { mode: "collect", kind: "inter_session", senderIsOwner: true, owner: false },
  { mode: "collect", kind: "external_user", senderIsOwner: false, owner: false },
  { mode: "followup", kind: "external_user", senderIsOwner: true, owner: true },
  { mode: "followup", kind: "inter_session", senderIsOwner: true, owner: false },
  { mode: "followup", kind: "external_user", senderIsOwner: false, owner: false },
] as const)(
  "preserves trusted owner provenance for $mode/$kind/$senderIsOwner",
  async ({ mode, kind, senderIsOwner, owner }) => {
    const inputProvenance = { kind, sourceTool: "test" };
    const settings = createQueueSettings({ mode, cap: mode === "collect" ? 50 : 1 });
    const firstDelivery = createDeferred<FollowupRun>();
    const retried = createDeferred<FollowupRun>();
    let attempts = 0;
    for (const prompt of ["first", "second"]) {
      const run = createRun({ prompt });
      run.run.senderIsOwner = senderIsOwner;
      run.run.inputProvenance = inputProvenance;
      run.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
        input: { text: prompt, senderIsOwner, provenance: inputProvenance },
        target: {
          agentId: run.run.agentId,
          sessionId: run.run.sessionId,
          sessionKey: key,
          sessionEntry: undefined,
        },
      });
      enqueueFollowupRun(key, run, settings);
    }
    scheduleFollowupDrain(key, async (run) => {
      attempts += 1;
      if (attempts === 1) {
        firstDelivery.resolve(run);
        if (mode === "followup") {
          throw new FollowupRunDeferredError("reply lane busy");
        }
      } else {
        retried.resolve(run);
      }
    });
    const deliveries = [await firstDelivery.promise];
    if (mode === "followup") {
      deliveries.push(await retried.promise);
    }
    for (const run of deliveries) {
      expect(run.prompt).toContain(
        mode === "collect" ? "[Queued messages while agent was busy]" : "[Queue overflow]",
      );
      expect(run.run).toMatchObject({ senderIsOwner, inputProvenance });
      for (const message of [
        run.userTurnTranscriptRecorder?.message,
        await run.userTurnTranscriptRecorder?.resolveMessage(),
      ]) {
        expect(message).toMatchObject({
          provenance: inputProvenance,
          __openclaw: { senderIsOwner: owner },
        });
      }
    }
  },
);
