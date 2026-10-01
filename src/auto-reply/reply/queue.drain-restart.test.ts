// Tests queue drain restart behavior when follow-up runs chain together.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  createQueueTestRun as createRun,
  createDrainRecorder,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/enqueue.test-support.js";
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
  clearSessionQueues([key]);
  resetGatewayWorkAdmission();
});
const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe("followup queue drain restart after idle window", () => {
  it("keeps a detached drain on a live root after its enqueue request returns", async () => {
    const parentReleased = createDeferred();
    const drained = createDeferred();
    const parent = tryBeginGatewayRootWorkAdmission();
    if (!parent) {
      throw new Error("expected parent Gateway work admission");
    }
    let suspensionStarted = false;
    let subordinateAdmissionClosed: boolean | undefined;
    let activeRootCountDuringDrain: number | undefined;
    let generationDuringDrain: unknown;
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
          enqueueFollowupRun(key, createRun({ prompt: "detached" }), defaults);
          scheduleFollowupDrain(key, async () => {
            await parentReleased.promise;
            const suspension = tryBeginGatewaySuspendAdmission(() => {});
            suspensionStarted = suspension !== null;
            try {
              generationDuringDrain = getPreparedModelRuntimePluginGeneration();
              subordinateAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
              activeRootCountDuringDrain = getActiveGatewayRootWorkCount();
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

      expect(suspensionStarted).toBe(true);
      expect(subordinateAdmissionClosed).toBe(false);
      expect(activeRootCountDuringDrain).toBe(1);
      expect(generationDuringDrain).toBeUndefined();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      parent.release();
      parentReleased.resolve();
    }
  });

  it("releases a detached drain root when its queue is cleared during debounce", async () => {
    const env = captureEnv(["OPENCLAW_TEST_FAST"]);
    setTestEnvValue("OPENCLAW_TEST_FAST", "0");
    const settings: QueueSettings = { mode: "followup", debounceMs: 60_000, cap: 50 };

    try {
      enqueueFollowupRun(key, createRun({ prompt: "clear during debounce" }), settings);
      scheduleFollowupDrain(key, async () => {});
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(1));

      clearSessionQueues([key]);

      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      clearSessionQueues([key]);
      env.restore();
    }
  });

  it("does not retain stale callbacks when scheduleFollowupDrain runs with an empty queue", async () => {
    const stale = createDrainRecorder();
    const fresh = createDrainRecorder();
    scheduleFollowupDrain(key, stale.runFollowup);
    enqueueFollowupRun(key, createRun({ prompt: "after-empty-schedule" }), defaults);
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
      clearSessionQueues([key]);
      drainA.clearFollowupDrainCallback(key);
      resetRecentQueuedMessageIdDedupe();
    }
  });

  it("retries a draining error when restart admission remains open", async () => {
    const delivered = createDeferred();
    let attempts = 0;

    const runFollowup = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new GatewayDrainingError();
      }
      delivered.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "retry while admission is open" }), defaults);
    scheduleFollowupDrain(key, runFollowup);
    await delivered.promise;
    await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
    expect(attempts).toBe(2);
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
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(attempts).toBe(1);
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  });

  it("resumes a queued followup after a restart-signal fence rolls back", async () => {
    const firstFailed =
      createDeferred<NonNullable<ReturnType<typeof beginGatewayRestartSignalAdmission>>>();
    const delivered = createDeferred();
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
      delivered.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "queued during pending restart" }), defaults);
    scheduleFollowupDrain(key, runFollowup);
    const signal = await firstFailed.promise;
    await nextTurn();
    expect(attempts).toBe(1);
    expect(getExistingFollowupQueue(key)?.items).toHaveLength(1);
    expect(signal.rollback()).toBe(true);
    await vi.waitFor(() => expect(attempts).toBe(2));
    await delivered.promise;
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  });

  it("refreshes the callback used by a deferred active-drain retry", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const retried = createDeferred();
    const staleCalls: FollowupRun[] = [];
    const freshCalls: FollowupRun[] = [];

    const staleFollowup = async (run: FollowupRun) => {
      staleCalls.push(run);
      firstStarted.resolve();
      await releaseFirst.promise;
      throw new FollowupRunDeferredError("reply lane busy");
    };
    const freshFollowup = async (run: FollowupRun) => {
      freshCalls.push(run);
      retried.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "wait-for-lane" }), defaults);
    scheduleFollowupDrain(key, staleFollowup);
    await firstStarted.promise;

    scheduleFollowupDrain(key, freshFollowup);
    releaseFirst.resolve();
    await retried.promise;

    expect(staleCalls).toHaveLength(1);
    expect(freshCalls).toHaveLength(1);
    expect(freshCalls[0]?.prompt).toBe("wait-for-lane");
  });

  it("bounds overflow identities across repeated deferred retries", async () => {
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
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
      const queue = getExistingFollowupQueue(key);
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
      expect(getExistingFollowupQueue(key)).toBe(queue);
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

      for (let pass = 0; pass < 2_000 && getExistingFollowupQueue(key); pass += 1) {
        await Promise.resolve();
      }
      if (getExistingFollowupQueue(key)) {
        forcedCleanup = true;
        clearSessionQueues([key]);
      }
      await timer;
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

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
      expect(getExistingFollowupQueue(key)).toBeUndefined();
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
    expect(getExistingFollowupQueue(key)?.items).toEqual([queued]);

    markGatewayRestartDraining();

    expect(getExistingFollowupQueue(key)).toBeUndefined();
    expect(abandoned).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
    resetGatewayWorkAdmission();
    enqueueFollowupRun(key, createRun({ prompt: "fresh lifecycle" }), defaults);
    await nextTurn();
    expect(staleCalls).toHaveLength(0);
    expect(getExistingFollowupQueue(key)?.items).toHaveLength(1);
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
});
