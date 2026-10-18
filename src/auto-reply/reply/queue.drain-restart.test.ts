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
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import {
  createReplyOperation,
  stopReplyOperationForRestart,
} from "../../sessions/session-controller.js";
import {
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  tryClaimSessionControllerTask,
} from "../../sessions/session-controller.mailbox.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "../../state/agent-database-admission-error.js";
import {
  assertAgentDatabaseResourceAdmission,
  withAgentDatabaseCloseFence,
} from "../../state/openclaw-agent-db-resources.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import {
  createQueueTestRun as createRun,
  createDrainRecorder,
  installQueueRuntimeErrorSilencer,
  rejectQueuePreparation,
} from "./queue.test-helpers.js";
import { kickFollowupDrainIfIdle } from "./queue/drain.js";
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
  clearFollowupQueue(key);
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
        rejectQueuePreparation(
          run,
          new AgentDatabaseExecutionAdmissionClosedError("database is still closing"),
        );
      }
      delivered(run);
    };
    const runFollowup = async (run: FollowupRun) => {
      if (++attempts > 1) {
        return retry(run);
      }
      refused.resolve();
      await release.promise;
      rejectQueuePreparation(
        run,
        new AgentDatabaseExecutionAdmissionClosedError("retired database owner"),
      );
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
        expect(queuedState()?.items).toEqual([queued]);
        expect(queuedState()?.draining).toBe(false);
      } else {
        expect(delivered).toHaveBeenCalledExactlyOnceWith(queued);
        expect(queuedState()).toBeUndefined();
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      release.resolve();
      vi.useRealTimers();
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
  const runFollowup = async (run: FollowupRun) => {
    attempts += 1;
    // Bound the broken implementation so the regression cannot starve Vitest.
    if (closing && attempts > 1) {
      clearFollowupQueue(key);
    }
    try {
      assertAgentDatabaseResourceAdmission(target);
    } catch (error) {
      if (!(error instanceof AgentDatabaseExecutionAdmissionClosedError)) {
        throw error;
      }
      rejectQueuePreparation(run, error);
    }
  };
  try {
    await withAgentDatabaseCloseFence(target, async () => {
      enqueueFollowupRun(key, queued, defaults);
      scheduleFollowupDrain(key, runFollowup);
      await vi.advanceTimersByTimeAsync(0);

      expect(attempts).toBe(1);
      expect(queuedState()?.items).toEqual([queued]);
      expect(queuedState()?.draining).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(settled).not.toHaveBeenCalled();
    });
    closing = false;
    kickFollowupDrainIfIdle(key);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    expect(queuedState()).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
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

it("keeps debounce dormant and does not acquire a root after the queue is cleared", async () => {
  resetGatewayWorkAdmission();
  vi.useFakeTimers();
  const queueKey = "test-cleared-debounce-root";
  const run = createRun({ prompt: "clear during debounce" });
  const execute = vi.fn(async () => {});
  try {
    enqueueFollowupRun(queueKey, run, { mode: "followup", debounceMs: 60_000, cap: 50 });
    scheduleFollowupDrain(queueKey, execute);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    clearFollowupQueue(queueKey);
    await run.controllerInput!.settlement.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  } finally {
    clearFollowupQueue(queueKey);
    vi.useRealTimers();
    resetGatewayWorkAdmission();
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
  const calls: FollowupRun[] = [];
  const firstProcessed = createDeferred();

  resetRecentQueuedMessageIdDedupe();

  try {
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length === 1) {
        firstProcessed.resolve();
      }
    };

    enqueueB.enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), defaults);
    drainA.scheduleFollowupDrain(key, runFollowup);
    await firstProcessed.promise;

    await nextTurn();

    enqueueB.enqueueFollowupRun(
      key,
      createRun({ prompt: "after-idle" }),
      defaults,
      "message-id",
      runFollowup,
    );

    await vi.waitFor(
      () => {
        expect(calls).toHaveLength(2);
      },
      { timeout: 1_000 },
    );

    expect(calls[0]?.prompt).toBe("before-idle");
    expect(calls[1]?.prompt).toBe("after-idle");
  } finally {
    clearFollowupQueue(key);

    resetRecentQueuedMessageIdDedupe();
  }
});

it("does not double-drain when a message arrives while drain is still running", async () => {
  const queueKey = `test-no-double-drain-${Date.now()}`;
  const calls: FollowupRun[] = [];
  const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

  const allProcessed = createDeferred();
  let runFollowupResolve: (() => void) | undefined;
  const runFollowupGate = new Promise<void>((res) => {
    runFollowupResolve = res;
  });
  const runFollowup = async (run: FollowupRun) => {
    await runFollowupGate;
    calls.push(run);
    if (calls.length >= 2) {
      allProcessed.resolve();
    }
  };

  enqueueFollowupRun(queueKey, createRun({ prompt: "first" }), settings);
  scheduleFollowupDrain(queueKey, runFollowup);
  enqueueFollowupRun(queueKey, createRun({ prompt: "second" }), settings);
  if (!runFollowupResolve) {
    throw new Error("Expected followup run release callback to be initialized");
  }
  runFollowupResolve();

  await allProcessed.promise;
  expect(calls).toHaveLength(2);
  expect(calls[0]?.prompt).toBe("first");
  expect(calls[1]?.prompt).toBe("second");
});

it("does not reschedule a drain after an active restart-drain rejection", async () => {
  resetGatewayWorkAdmission();
  const queueKey = `test-restart-drain-rejection-${Date.now()}`;
  const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
  const firstFailed = createDeferred();
  let attempts = 0;

  const runFollowup = async () => {
    attempts += 1;
    if (attempts === 1) {
      markGatewayRestartDraining();
      firstFailed.resolve();
      throw new GatewayDrainingError();
    }
  };

  try {
    enqueueFollowupRun(queueKey, createRun({ prompt: "queued during restart" }), settings);
    scheduleFollowupDrain(queueKey, runFollowup);
    await firstFailed.promise;
    await vi.waitFor(() => {
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    expect(attempts).toBe(1);
    expect(getExistingFollowupQueue(queueKey)).toBeUndefined();
  } finally {
    clearFollowupQueue(queueKey);
    resetGatewayWorkAdmission();
  }
});

it("does not replay a selected turn after a draining error", async () => {
  resetGatewayWorkAdmission();
  const queueKey = `test-draining-error-with-open-admission-${Date.now()}`;
  const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

  const delivered = createDeferred();
  let attempts = 0;
  const abandoned = vi.fn();

  const runFollowup = async () => {
    attempts += 1;
    if (attempts === 1) {
      delivered.resolve();
      throw new GatewayDrainingError();
    }
    delivered.resolve();
  };

  try {
    const source = createRun({ prompt: "retry while admission is open" });
    source.turnAdoptionLifecycle = { onAdopted: async () => {}, onAbandoned: abandoned };
    enqueueFollowupRun(queueKey, source, settings);
    scheduleFollowupDrain(queueKey, runFollowup);
    await delivered.promise;
    await vi.waitFor(() => {
      expect(getExistingFollowupQueue(queueKey)).toBeUndefined();
    });
    expect(attempts).toBe(1);
    expect(abandoned).not.toHaveBeenCalled();
  } finally {
    clearFollowupQueue(queueKey);
    resetGatewayWorkAdmission();
  }
});

it("does not reschedule when a restart-signal fence commits to drain", async () => {
  const firstFailed =
    createDeferred<NonNullable<ReturnType<typeof beginGatewayRestartSignalAdmission>>>();
  let attempts = 0;

  const runFollowup = async () => {
    attempts += 1;
    if (attempts === 1) {
      const signal = beginGatewayRestartSignalAdmission();
      if (!signal) {
        throw new Error("expected restart-signal fence");
      }
      firstFailed.resolve(signal);
      throw new GatewayDrainingError();
    }
  };

  enqueueFollowupRun(key, createRun({ prompt: "queued during restart commit" }), defaults);
  scheduleFollowupDrain(key, runFollowup);
  await firstFailed.promise;
  markGatewayRestartDraining();
  await waitForRoots();
  expect(attempts).toBe(1);
  expect(queuedState()).toBeUndefined();
});

it.each(["followup", "collect"] as const)(
  "waits for a normal drain kick after a restart signal rolls back (%s)",
  async (mode) => {
    resetGatewayWorkAdmission();
    const queueKey = `test-restart-signal-rollback-${mode}`;
    const run = createRun({ prompt: "queued during pending restart" });
    enqueueFollowupRun(queueKey, run, { mode, debounceMs: 0, cap: 50 });
    const signal = beginGatewayRestartSignalAdmission();
    if (!signal) {
      throw new Error("expected restart-signal fence");
    }

    const delivered = createDeferred();
    const execute = vi.fn(async () => {
      delivered.resolve();
    });
    try {
      scheduleFollowupDrain(queueKey, execute);
      expect(execute).not.toHaveBeenCalled();
      expect(getExistingFollowupQueue(queueKey)?.items).toEqual([run]);
      expect(signal.rollback()).toBe(true);
      await vi.waitFor(() => expect(getExistingFollowupQueue(queueKey)?.draining).toBe(false));
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(execute).not.toHaveBeenCalled();
      kickFollowupDrainIfIdle(queueKey);
      await delivered.promise;
      await run.controllerInput!.settlement.promise;
      await run.controllerInput!.claim?.settlement.promise;
      await waitForRoots();
      expect(execute).toHaveBeenCalledOnce();
      expect(getExistingFollowupQueue(queueKey)).toBeUndefined();
    } finally {
      signal.rollback();
      clearFollowupQueue(queueKey);
      resetGatewayWorkAdmission();
    }
  },
);

it.each([
  [true, "external_user", true],
  [true, "inter_session", false],
  [true, "internal_system", false],
  [false, "external_user", false],
] as const)(
  "preserves overflow summaries and human ownership for %s/%s",
  async (senderIsOwner, kind, owner) => {
    const queueKey = `test-deferred-summary-retry-${Date.now()}`;
    const prompts: string[] = [];
    const followups: FollowupRun[] = [];
    const inputProvenance = { kind, sourceTool: "test" };
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const retried = createDeferred();
    let attempts = 0;

    const runFollowup = async (run: FollowupRun) => {
      attempts++;
      prompts.push(run.prompt);
      followups.push(run);
      if (attempts < 2) {
        return;
      }
      retried.resolve();
    };

    for (const prompt of ["dropped while busy", "kept while busy"]) {
      const followup = createRun({ prompt });
      followup.run.senderIsOwner = senderIsOwner;
      followup.run.inputProvenance = inputProvenance;
      enqueueFollowupRun(queueKey, followup, settings);
    }
    scheduleFollowupDrain(queueKey, runFollowup);

    await retried.promise;

    expect(attempts).toBe(2);
    for (const run of followups.slice(0, 1)) {
      expect(run).toMatchObject({
        run: { senderIsOwner, inputProvenance },
        userTurnTranscriptRecorder: {
          message: { provenance: inputProvenance, __openclaw: { senderIsOwner: owner } },
        },
      });
    }
    expect(prompts[0]).toContain("Dropped 1 message");
    expect(prompts[0]).toContain("dropped while busy");
    expect(prompts[1]).toBe("kept while busy");
  },
);

it.each([
  [true, "external_user", true],
  [true, "inter_session", false],
  [true, "internal_system", false],
  [false, "external_user", false],
] as const)("keeps collected human ownership for %s/%s", async (senderIsOwner, kind, owner) => {
  const queueKey = `test-collected-human-owner-${Date.now()}`;
  const inputProvenance = { kind, sourceTool: "test" };
  const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
  const collected = createDeferred<FollowupRun>();
  for (const prompt of ["first", "second"]) {
    const followup = createRun({ prompt });
    followup.run.senderIsOwner = senderIsOwner;
    followup.run.inputProvenance = inputProvenance;
    followup.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
      input: { text: prompt, senderIsOwner, provenance: inputProvenance },
      target: {
        agentId: followup.run.agentId,
        sessionId: followup.run.sessionId,
        sessionKey: queueKey,
        sessionEntry: undefined,
      },
    });
    enqueueFollowupRun(queueKey, followup, settings);
  }
  scheduleFollowupDrain(queueKey, async (run) => collected.resolve(run));
  const followup = await collected.promise;
  expect(followup.run.senderIsOwner).toBe(senderIsOwner);
  for (const message of [
    followup.userTurnTranscriptRecorder?.message,
    await followup.userTurnTranscriptRecorder?.resolveMessage(),
  ]) {
    expect(message).toMatchObject({
      provenance: inputProvenance,
      __openclaw: { senderIsOwner: owner },
    });
  }
});

it.each(["old", "new"] as const)(
  "drains a pending overflow summary after future drops switch to %s",
  async (dropPolicy) => {
    const summarizeSettings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const nonOutcomeAbandoned = vi.fn();
    const nonOutcomeDisposition = vi.fn();
    const nonOutcomeSettled = vi.fn();
    const createRecordedNonOutcome = (prompt: string) => {
      const run = createRun({ prompt });
      run.onQueueDisposition = nonOutcomeDisposition;
      run.turnAdoptionLifecycle = {
        admission: "cancel-only",
        onAdopted: vi.fn(),
        onAbandoned: nonOutcomeAbandoned,
        onSettled: nonOutcomeSettled,
      };
      return run;
    };
    const first = createRun({ prompt: "first overflowed message" });
    const second =
      dropPolicy === "old"
        ? createRecordedNonOutcome("second queued message")
        : createRun({ prompt: "second queued message" });
    const third =
      dropPolicy === "new"
        ? createRecordedNonOutcome("third rejected message")
        : createRun({ prompt: "third queued message" });
    const deliveredPrompts: string[] = [];
    let forcedCleanup = false;
    let timerFired = false;

    expect(enqueueFollowupRun(key, first, summarizeSettings)).toBe(true);
    expect(enqueueFollowupRun(key, second, summarizeSettings)).toBe(true);
    const queue = queuedState();
    expect(queue).toMatchObject({
      dropPolicy: "summarize",
      droppedCount: 1,
      summaryLines: ["first overflowed message"],
    });
    expect(queue?.summarySources).toEqual([first]);
    expect(queue?.items).toEqual([second]);

    const admitted = enqueueFollowupRun(key, third, {
      ...summarizeSettings,
      dropPolicy,
    });
    expect(admitted).toBe(dropPolicy === "old");
    expect(queuedState()).toBe(queue);
    expect(queue).toMatchObject({
      dropPolicy,
      droppedCount: 1,
      summaryLines: ["first overflowed message"],
    });
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

    for (let pass = 0; pass < 2_000 && queuedState(); pass += 1) {
      await Promise.resolve();
    }
    if (queuedState()) {
      forcedCleanup = true;
      clearFollowupQueue(key);
    }
    await timer;
    await waitForRoots();

    expect(forcedCleanup).toBe(false);
    expect(timerFired).toBe(true);
    expect(deliveredPrompts).toHaveLength(2);
    expect(deliveredPrompts[0]).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(deliveredPrompts[0]).toContain("first overflowed message");
    expect(deliveredPrompts[1]).toBe(
      dropPolicy === "old" ? "third queued message" : "second queued message",
    );
    expect(nonOutcomeDisposition).toHaveBeenCalledWith(`queue-cap-${dropPolicy}`);
    expect(nonOutcomeAbandoned).toHaveBeenCalledOnce();
    expect(nonOutcomeSettled).toHaveBeenCalledTimes(1);
    expect(queuedState()).toBeUndefined();
  },
);

it("retires queued followups and callbacks when one-way restart drain begins", async () => {
  const abandoned = vi.fn();
  const settled = vi.fn();
  const staleCalls: FollowupRun[] = [];
  const queued = createRun({ prompt: "retire on lifecycle restart" });
  queued.turnAdoptionLifecycle = {
    admission: "cancel-only",
    onAdopted: async () => {},
    onAbandoned: abandoned,
    onSettled: settled,
  };

  enqueueFollowupRun(
    key,
    queued,
    defaults,
    "message-id",
    async (run) => {
      staleCalls.push(run);
    },
    false,
  );
  expect(queuedState()?.items).toEqual([queued]);

  markGatewayRestartDraining();
  await queued.controllerInput!.settlement.promise;

  expect(queuedState()).toBeUndefined();
  expect(abandoned).toHaveBeenCalledOnce();
  expect(settled).toHaveBeenCalledOnce();
  resetGatewayWorkAdmission();
  enqueueFollowupRun(key, createRun({ prompt: "fresh lifecycle" }), defaults);
  await nextTurn();
  expect(staleCalls).toHaveLength(0);
  expect(queuedState()?.items).toHaveLength(1);
});

it.each(["outside the turn", "inside the turn"] as const)(
  "preserves a claimed input for typed shutdown cancellation when restart begins %s",
  async (requester) => {
    const otherKey = `${key}-other`;
    const queued = createRun({ prompt: "queued before restart" });
    enqueueFollowupRun(otherKey, queued, defaults, "message-id", async () => {}, false);
    const input = reserveSessionControllerSource(key, { policy: defaults });
    const claim = tryClaimSessionControllerTask(input);
    if (!claim) {
      throw new Error("expected turn claim");
    }
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: "running-session",
      resetTriggered: false,
      mailboxClaim: claim,
      upstreamAbortSignal: claim.abortController.signal,
    });
    try {
      if (requester === "inside the turn") {
        withSessionControllerOwner(operation, () => markGatewayRestartDraining());
      } else {
        markGatewayRestartDraining();
      }
      await queued.controllerInput!.settlement.promise;
      expect(getExistingFollowupQueue(otherKey)).toBeUndefined();
      expect(input.abortSignal.aborted).toBe(false);
      expect(claim.abortController.signal.aborted).toBe(false);
      expect(operation.abortSignal.aborted).toBe(false);

      expect(stopReplyOperationForRestart(operation)).toBe(true);
      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    } finally {
      operation.complete();
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
      clearFollowupQueue(otherKey);
    }
  },
);

it("retires native inputs waiting behind a running turn without a followup callback", async () => {
  const running = reserveSessionControllerSource(key, { policy: defaults });
  const claim = tryClaimSessionControllerTask(running);
  if (!claim) {
    throw new Error("expected turn claim");
  }
  const waiting = reserveSessionControllerSource(key, { policy: defaults });
  try {
    markGatewayRestartDraining();
    expect(waiting.abortSignal.reason).toEqual(new Error("Session mailbox cleared"));
    await waiting.settlement.promise;
    expect(running.abortSignal.aborted).toBe(false);
    expect(claim.abortController.signal.aborted).toBe(false);
  } finally {
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
  }
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
    const settings: QueueSettings = {
      mode,
      debounceMs: 0,
      cap: mode === "collect" ? 50 : 1,
      dropPolicy: "summarize",
    };
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
          run.controllerClaim!.retryBeforeExecution = true;
          throw new Error("reply lane busy");
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
