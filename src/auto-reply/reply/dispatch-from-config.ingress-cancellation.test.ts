import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindIngressLifecycleToReplyOptions,
  type ChannelIngressDispatchLifecycle,
} from "../../channels/message/ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "../../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  observeChannelIngressQueueWrite,
  observeChannelIngressQueueWrites,
  withTempState,
} from "../../channels/message/ingress-drain.test-helpers.js";
import { fanInChannelIngressLifecycles } from "../../plugin-sdk/channel-ingress-runtime.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import { createInboundDebouncer } from "../inbound-debounce.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import { createDispatcher } from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import {
  withDispatchProcessedOutcomeSink,
  type DispatchProcessedNote,
} from "./dispatch-processed-outcome.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import {
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/recent-message-ids.test-support.js";
import { clearFollowupQueue } from "./queue/state.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
  resetRecentQueuedMessageIdDedupe();
  vi.useFakeTimers();
});
afterEach(() => {
  controllerTesting.resetSessionControllerForTest();
  resetInboundDedupe();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const QUEUE_SETTINGS = {
  mode: "followup",
  debounceMs: 0,
  cap: 10,
  dropPolicy: "summarize",
} as const;

// One attempt and no age floor: any abandonment dead-letters immediately, so a
// cancellation that leaked into the retry budget would be visible at once.
const ONE_ATTEMPT = { maxAttempts: 1, deadLetterMinAgeMs: 0, baseMs: 0, maxMs: 0 } as const;

describe("queued ingress cancellation through the reply terminal path", () => {
  it("settles the durable claim once through cancellation and keeps its retry budget", async () => {
    await withTempState(async (stateDir) => {
      let clock = Date.now();
      const key = "agent:main:discord:direct:ingress-cancel";
      const messageId = "cancel-me";
      const prompt = "Please deliver this queued message";
      const ctx = buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        From: "user:ingress-fixture",
        To: "channel:ingress-fixture",
        SessionKey: key,
        MessageSid: messageId,
        BodyForAgent: prompt,
      });
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(messageId, { text: prompt }, { laneKey: key });

      // Counted at the durable owner: the whole chain must deliver exactly one
      // cancellation and never fall back to a budget-spending abandonment.
      const cancelled = vi.fn();
      const abandoned = vi.fn();
      const flushErrors: unknown[] = [];
      const outcomes: Array<DispatchProcessedNote | undefined> = [];
      const finishAbortedFollowup = vi.fn(async (run: FollowupRun) => {
        expect(run.abortSignal?.aborted).toBe(true);
      });
      let dispatcher = createDispatcher();

      const buildQueuedRun = (options?: GetReplyOptions) => {
        const run = createQueueTestRun({
          prompt,
          messageId,
          originatingChannel: "discord",
          originatingTo: "channel:ingress-fixture",
        });
        run.turnAdoptionLifecycle = options?.turnAdoptionLifecycle;
        run.abortSignal = options?.turnAdoptionLifecycle?.abortSignal;
        return run;
      };

      const resolver = vi.fn(async (_ctx: MsgContext, options?: GetReplyOptions) => {
        if (resolver.mock.calls.length > 1) {
          return { text: "Queued message delivered" };
        }
        expect(
          enqueueFollowupRun(
            key,
            buildQueuedRun(options),
            QUEUE_SETTINGS,
            "message-id",
            finishAbortedFollowup,
            false,
          ),
        ).toBe(true);
        const runState = resolveReplyOperationRunState(options);
        if (!runState) {
          throw new Error("dispatch did not bind its run state");
        }
        runState.admission = { status: "accepted", mode: "followup" };
        return undefined;
      });

      // Real channel shape: durable claim -> fan-in -> inbound debounce flush ->
      // bound reply options -> dispatch -> followup queue.
      const debouncer = createInboundDebouncer<{
        key: string;
        lifecycle: ChannelIngressDispatchLifecycle;
      }>({
        debounceMs: 0,
        buildKey: (entry) => entry.key,
        onFlush: (entries, createFlush) => {
          const fanned = fanInChannelIngressLifecycles(entries.map((entry) => entry.lifecycle));
          return createFlush({
            lifecycle: fanned.lifecycle,
            dispatch: async (admissionLifecycle) => {
              const { processedOutcome } = await withDispatchProcessedOutcomeSink(() =>
                dispatchReplyFromConfig({
                  ctx,
                  cfg: automaticDirectReplyConfig,
                  dispatcher,
                  replyOptions: bindIngressLifecycleToReplyOptions(admissionLifecycle),
                  replyResolver: resolver,
                }),
              );
              outcomes.push(processedOutcome);
            },
          });
        },
        onError: (err) => flushErrors.push(err),
      });

      const stop = new AbortController();
      const drain = createChannelIngressDrain({
        queue,
        now: () => clock,
        abortSignal: stop.signal,
        retryPolicy: ONE_ATTEMPT,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          const instrumented: ChannelIngressDispatchLifecycle = {
            ...lifecycle,
            onCancelled: async () => {
              cancelled();
              await lifecycle.onCancelled?.();
            },
            onAbandoned: async () => {
              abandoned();
              await lifecycle.onAbandoned();
            },
          };
          await debouncer.enqueue({ key, lifecycle: instrumented });
          return { kind: "deferred" };
        },
      });

      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        expect(flushErrors).toEqual([]);
        expect(resolver).toHaveBeenCalledOnce();
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        expect(await queue.listClaims()).toHaveLength(1);

        // Gateway stop while the turn is still queued: the followup queue's
        // abort path cancels ownership instead of abandoning it.
        const released = observeChannelIngressQueueWrite(queue, "release", messageId);
        stop.abort();
        await expect(released).resolves.toBe(true);
        await drain.waitForIdle();

        expect(cancelled).toHaveBeenCalledOnce();
        expect(abandoned).not.toHaveBeenCalled();
        expect(finishAbortedFollowup).toHaveBeenCalledOnce();
        const pending = await queue.listPending();
        expect(pending).toEqual([expect.objectContaining({ id: messageId, attempts: 0 })]);
        expect(pending[0]?.lastError ?? undefined).toBeUndefined();
        expect(await queue.listFailed?.()).toEqual([]);

        // Cancellation ran the pre-retry dedupe releases, so the same message id
        // may be queued again rather than being silently swallowed.
        expect(
          enqueueFollowupRun(
            key,
            buildQueuedRun(),
            QUEUE_SETTINGS,
            "message-id",
            finishAbortedFollowup,
            false,
          ),
        ).toBe(true);
        clearSessionQueues([key]);

        // The recovered claim still delivers; inbound dedupe was released too.
        clock += 1_000;
        dispatcher = createDispatcher();
        const recovery = createChannelIngressDrain({
          queue,
          now: () => clock,
          retryPolicy: ONE_ATTEMPT,
          dispatchClaimedEvent: async (_event, lifecycle) => {
            await debouncer.enqueue({ key, lifecycle });
          },
        });
        try {
          expect(await recovery.drainOnce()).toEqual({ started: 1 });
          await recovery.waitForIdle();
        } finally {
          recovery.dispose();
        }
        expect(flushErrors).toEqual([]);
        expect(resolver).toHaveBeenCalledTimes(2);
        expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
          text: "Queued message delivered",
        });
        expect(outcomes.at(-1)).toMatchObject({ outcome: "completed" });
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        drain.dispose();
        clearSessionQueues([key]);
      }
    });
  });

  it("clears a queue of unadmitted work without charging any claim an attempt", async () => {
    await withTempState(async (stateDir) => {
      const key = "agent:main:discord:direct:ingress-clear";
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("first", { text: "a" }, { laneKey: "lane-a" });
      await queue.enqueue("second", { text: "b" }, { laneKey: "lane-b" });
      const drain = createChannelIngressDrain({
        queue,
        retryPolicy: ONE_ATTEMPT,
        dispatchClaimedEvent: async (event, lifecycle) => {
          const run: FollowupRun = {
            ...createQueueTestRun({ prompt: event.id, messageId: event.id }),
            turnAdoptionLifecycle:
              bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle,
          };
          expect(enqueueFollowupRun(key, run, QUEUE_SETTINGS, "message-id", undefined, false)).toBe(
            true,
          );
          return { kind: "deferred" };
        },
      });

      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        expect(await queue.listClaims()).toHaveLength(2);

        // The queue is cleared while both turns wait for admission.
        const released = observeChannelIngressQueueWrites(queue, {
          first: "release",
          second: "release",
        });
        expect(clearFollowupQueue(key)).toBe(2);
        await expect(released).resolves.toEqual({ first: true, second: true });
        expect(await queue.listClaims()).toEqual([]);

        expect(await queue.listPending()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "first", attempts: 0 }),
            expect.objectContaining({ id: "second", attempts: 0 }),
          ]),
        );
        expect(await queue.listFailed?.()).toEqual([]);
      } finally {
        drain.dispose();
        clearSessionQueues([key]);
      }
    });
  });

  it("cancels a waiting durable turn on gateway restart without charging its retry budget", async () => {
    // Bind the mailbox restart listener to a fresh drain signal for this case.
    resetGatewayWorkAdmission();
    await withTempState(async (stateDir) => {
      const key = "agent:main:discord:direct:ingress-restart";
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("restart-waiting", { text: "a" }, { laneKey: "lane-a" });
      const cancelled = vi.fn();
      const abandoned = vi.fn();
      const drain = createChannelIngressDrain({
        queue,
        retryPolicy: ONE_ATTEMPT,
        dispatchClaimedEvent: async (event, lifecycle) => {
          // Counted at the durable owner, behind the real bound reply lifecycle.
          const observed: ChannelIngressDispatchLifecycle = {
            ...lifecycle,
            onCancelled: async () => {
              cancelled();
              await lifecycle.onCancelled?.();
            },
            onAbandoned: async () => {
              abandoned();
              await lifecycle.onAbandoned();
            },
          };
          const run: FollowupRun = {
            ...createQueueTestRun({ prompt: event.id, messageId: event.id }),
            turnAdoptionLifecycle:
              bindIngressLifecycleToReplyOptions(observed).turnAdoptionLifecycle,
          };
          expect(enqueueFollowupRun(key, run, QUEUE_SETTINGS, "message-id", undefined, false)).toBe(
            true,
          );
          return { kind: "deferred" };
        },
      });

      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({ id: "restart-waiting", attempts: 0 }),
        ]);

        // Restart relinquishes the waiting turn on purpose. With one attempt and
        // no age floor, an abandonment here would dead-letter the row at once.
        const settled = Promise.race([
          observeChannelIngressQueueWrite(queue, "release", "restart-waiting").then(
            (written) => written && "release",
          ),
          observeChannelIngressQueueWrite(queue, "fail", "restart-waiting").then(
            (written) => written && "fail",
          ),
        ]);
        markGatewayRestartDraining();
        await expect(settled).resolves.toBe("release");
        expect(cancelled).toHaveBeenCalledOnce();
        expect(abandoned).not.toHaveBeenCalled();
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listFailed?.()).toEqual([]);
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({ id: "restart-waiting", attempts: 0 }),
        ]);
        expect((await queue.listPending())[0]?.lastError).toBeUndefined();
      } finally {
        drain.dispose();
        clearSessionQueues([key]);
        resetGatewayWorkAdmission();
      }
    });
  });

  it("cancels every durable claim of a fan-in through the bound reply lifecycle", async () => {
    await withTempState(async (stateDir) => {
      const key = "agent:main:discord:direct:ingress-fan-in-cancel";
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("one", { text: "x" }, { laneKey: "lane-one" });
      await queue.enqueue("two", { text: "x" }, { laneKey: "lane-two" });
      const claimed = new Map<string, ChannelIngressDispatchLifecycle>();
      const drain = createChannelIngressDrain({
        queue,
        retryPolicy: ONE_ATTEMPT,
        dispatchClaimedEvent: async (event, lifecycle) => {
          claimed.set(event.id, lifecycle);
          lifecycle.onDeferred();
          return { kind: "deferred" };
        },
      });

      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        const one = claimed.get("one");
        const two = claimed.get("two");
        if (!one || !two) {
          throw new Error("drain did not claim both events");
        }
        const fanned = fanInChannelIngressLifecycles([one, two]);
        const run: FollowupRun = {
          ...createQueueTestRun({ prompt: "fanned", messageId: "fanned" }),
          turnAdoptionLifecycle: fanned.lifecycle
            ? bindIngressLifecycleToReplyOptions(fanned.lifecycle).turnAdoptionLifecycle
            : undefined,
        };

        const released = observeChannelIngressQueueWrites(queue, {
          one: "release",
          two: "release",
        });
        completeFollowupRunLifecycle(run, "cancelled");
        await expect(released).resolves.toEqual({ one: true, two: true });
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "one", attempts: 0 }),
            expect.objectContaining({ id: "two", attempts: 0 }),
          ]),
        );
        expect(await queue.listFailed?.()).toEqual([]);
      } finally {
        drain.dispose();
        clearSessionQueues([key]);
      }
    });
  });

  it("cancels a collect-group source aborted while its group drain is awaited", async () => {
    await withTempState(async (stateDir) => {
      const key = "agent:main:discord:direct:ingress-collect-cancel";
      const queue = createTestIngressQueue(stateDir);
      // Distinct ingress lanes so both claims are held while one session queue
      // collects them into a single group.
      await queue.enqueue("cancelled-item", { text: "a" }, { laneKey: "lane-a" });
      await queue.enqueue("surviving-item", { text: "b" }, { laneKey: "lane-b" });
      const aborts = new Map<string, AbortController>();
      const drain = createChannelIngressDrain({
        queue,
        retryPolicy: ONE_ATTEMPT,
        dispatchClaimedEvent: async (event, lifecycle) => {
          const abort = new AbortController();
          aborts.set(event.id, abort);
          const run: FollowupRun = {
            ...createQueueTestRun({
              prompt: event.id,
              messageId: event.id,
              originatingChannel: "discord",
              originatingTo: "channel:ingress-fixture",
            }),
            abortSignal: abort.signal,
            turnAdoptionLifecycle:
              bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle,
          };
          expect(
            enqueueFollowupRun(
              key,
              run,
              { mode: "collect", debounceMs: 0, cap: 10, dropPolicy: "summarize" },
              "message-id",
              undefined,
              false,
            ),
          ).toBe(true);
          return { kind: "deferred" };
        },
      });

      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        expect(await queue.listClaims()).toHaveLength(2);

        // The collect group never admits, and one source is aborted mid-drain:
        // the post-drain cancellation sweep must not spend its retry budget.
        const groupRuns: string[] = [];
        const settled = observeChannelIngressQueueWrites(queue, {
          "cancelled-item": "release",
          "surviving-item": "fail",
        });
        scheduleFollowupDrain(key, async (run) => {
          groupRuns.push(run.prompt);
          aborts.get("cancelled-item")?.abort();
        });
        await expect(settled).resolves.toEqual({ "cancelled-item": true, "surviving-item": true });
        expect(await queue.listClaims()).toEqual([]);

        expect(groupRuns.length).toBeGreaterThan(0);
        // Same ceiling, opposite dispositions: the aborted source keeps its
        // budget while the one that merely never admitted spends its last try.
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({ id: "cancelled-item", attempts: 0 }),
        ]);
        expect(await queue.listFailed?.()).toEqual([
          expect.objectContaining({
            id: "surviving-item",
            reason: "retry-limit-exceeded",
            message: "turn-abandoned",
          }),
        ]);
      } finally {
        drain.dispose();
        clearSessionQueues([key]);
      }
    });
  });
});
