import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  createChannelAdmissionAudit,
  consumeChannelAdmissionEvidence,
} from "../../channels/message-access/admission-evidence.js";
import {
  IngressAdoptionLostError,
  isIngressAdoptionLostError,
} from "../../channels/message/ingress-drain-state.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { captureGatewayRootWorkReleaseObserver } from "../../process/gateway-work-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createQueueCase } from "./queue.case.test-support.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  refreshQueuedFollowupSession,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  createQueueTestRun as createRun,
  enqueueTestRun,
  rejectQueuePreparation,
  enqueueSlackRun,
  createQueueSettings,
  createDrainRecorder,
  drainRecordedQueue,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resolveFollowupDeliveryStorageKey } from "./queue/delivery-context.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import {
  FollowupRunDeferredError,
  isFollowupRunAborted,
  type InternalFollowupRun,
  type QueuedFollowupReplyBatch,
} from "./queue/types.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-overflow-session-");
installQueueRuntimeErrorSilencer();

async function drainSettledQueue(key: string, execute: (run: FollowupRun) => Promise<void>) {
  const receipts = getExistingFollowupQueue(key)!.entries.map((input) => input.settlement.promise);
  scheduleFollowupDrain(key, execute);
  await Promise.allSettled(receipts);
}

function createKeyedQueueCase(
  key: string,
  overrides: Partial<QueueSettings> = {},
  expectedCalls = 1,
) {
  return { key, ...createDrainRecorder(expectedCalls), settings: createQueueSettings(overrides) };
}

function enqueueTestRuns(
  key: string,
  settings: QueueSettings,
  ...runs: Parameters<typeof createRun>[0][]
) {
  for (const run of runs) {
    enqueueTestRun(key, run, settings);
  }
}

function enqueueRoutedRuns(
  key: string,
  settings: QueueSettings,
  route: Omit<Parameters<typeof createRun>[0], "prompt">,
  ...prompts: string[]
) {
  for (const prompt of prompts) {
    enqueueTestRun(key, { prompt, ...route }, settings);
  }
}

describe("followup queue collect routing", () => {
  it.each([false, true])(
    "notifies every collected run observer before surfacing a callback failure (throws: %s)",
    async (throws) => {
      const q = createQueueCase();
      const error = new Error("first observer failed");
      const first = vi.fn(() => {
        if (throws) {
          throw error;
        }
      });
      const second = vi.fn();
      const onModelSelected = vi.fn();
      for (const [prompt, runObservers] of [
        ["first", { onAgentRunTerminalOutcome: first }],
        ["second", { onAgentRunTerminalOutcome: second }],
        ["last", { onModelSelected }],
      ] as const) {
        q.add({ ...createRun({ prompt, originatingChannel: "a2a" }), runObservers });
      }
      await q.drain();
      expect(q.calls).toHaveLength(1);
      const observers = q.calls[0]!.runObservers;
      expect(observers?.onModelSelected).toBe(onModelSelected);
      const fail = () => observers?.onAgentRunTerminalOutcome?.("failed");
      if (throws) {
        expect(fail).toThrow(error);
      } else {
        fail();
      }
      expect(first).toHaveBeenCalledExactlyOnceWith("failed");
      expect(second).toHaveBeenCalledExactlyOnceWith("failed");
    },
  );

  it("settles every collected source while publishing content once", async () => {
    const q = createQueueCase();
    const first = vi.fn();
    const last = vi.fn();
    const recovery = vi.fn();
    const firstRetry = vi.fn(() => vi.fn());
    const lastRetry = vi.fn(() => recovery);
    for (const [prompt, deliver, createSourceRetry] of [
      ["first", first, firstRetry],
      ["last", last, lastRetry],
    ] as const) {
      q.add({
        ...createRun({ prompt, originatingChannel: "webchat" }),
        queuedFollowupReplyDisposition: {
          kind: "deliver",
          deliver: Object.assign(deliver, {
            ownsCompletion: (channel: string | undefined) => channel === "webchat",
            createSourceRetry,
          }),
        },
      });
    }
    await q.drain();
    expect(q.calls).toHaveLength(1);
    const owner = q.calls[0]?.queuedFollowupReplyDisposition;
    if (owner?.kind !== "deliver") {
      throw new Error("Collected execution lost its source delivery owner");
    }
    expect(first).not.toHaveBeenCalled();
    expect(last).not.toHaveBeenCalled();
    expect(owner.deliver.ownsCompletion?.("webchat")).toBe(true);
    expect(owner.deliver.ownsCompletion?.("discord")).toBe(false);
    const progress: QueuedFollowupReplyBatch = {
      kind: "queued-followup",
      runId: "batch-execution",
      originatingChannel: "webchat",
      payloads: [{ text: "working" }],
      completion: { kind: "progress" },
    };
    await owner.deliver(progress);
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledExactlyOnceWith(progress);
    const terminal: QueuedFollowupReplyBatch = {
      ...progress,
      payloads: [{ text: "done" }],
      completion: { kind: "completed", stopReason: "stop" },
    };
    await owner.deliver(terminal);
    expect(first).toHaveBeenCalledExactlyOnceWith({ ...terminal, payloads: [] });
    expect(last).toHaveBeenCalledTimes(2);
    expect(last).toHaveBeenLastCalledWith(terminal);
    const retry = owner.deliver.createSourceRetry?.();
    await retry?.({ ...terminal, runId: "recovery-execution" });
    expect(firstRetry).not.toHaveBeenCalled();
    expect(lastRetry).toHaveBeenCalledOnce();
    expect(recovery).toHaveBeenCalledExactlyOnceWith({
      ...terminal,
      runId: "recovery-execution",
    });
    expect(first).toHaveBeenCalledOnce();
  });

  it("settles remaining collected sources before surfacing a terminal delivery failure", async () => {
    const q = createQueueCase();
    const releaseDelivery = createDeferred();
    const deliveryStarted = createDeferred();
    const events: string[] = [];
    const error = new Error("first source delivery failed");
    q.add({
      ...createRun({ prompt: "first", originatingChannel: "webchat" }),
      queuedFollowupReplyDisposition: {
        kind: "deliver",
        deliver: () => {
          throw error;
        },
      },
    });
    q.add({
      ...createRun({ prompt: "last", originatingChannel: "webchat" }),
      queuedFollowupReplyDisposition: {
        kind: "deliver",
        deliver: async () => {
          deliveryStarted.resolve();
          await releaseDelivery.promise;
          events.push("last source settled");
        },
      },
    });
    await q.drain();
    const owner = q.calls[0]?.queuedFollowupReplyDisposition;
    if (owner?.kind !== "deliver") {
      throw new Error("Collected execution lost its source delivery owner");
    }
    const delivery = Promise.resolve(
      owner.deliver({
        kind: "queued-followup",
        runId: "batch-execution",
        originatingChannel: "webchat",
        payloads: [],
        completion: { kind: "completed" },
      }),
    ).catch((failure: unknown) => {
      events.push("failure surfaced");
      throw failure;
    });
    const rejected = expect(delivery).rejects.toBe(error);
    await deliveryStarted.promise;
    releaseDelivery.resolve();
    await rejected;
    expect(events).toEqual(["last source settled", "failure surfaced"]);
  });

  it("carries queued local cron-authority unavailability through a collect batch", async () => {
    const q = createQueueCase({}, 1);
    const first = createRun({ prompt: "first queued turn" });
    first.turnAdoptionLifecycle = {
      admission: "cancel-only",
      ownerKey: "gateway:local",
      cronCreatorAuthorityUnavailable: "queued-local-operator",
      onAdopted: async () => {},
    };
    const second = createRun({ prompt: "second queued turn" });
    second.turnAdoptionLifecycle = {
      admission: "cancel-only",
      ownerKey: "gateway:local",
      onAdopted: async () => {},
    };
    q.add(first);
    q.add(second);
    q.start();
    await q.done.promise;
    expect(q.calls[0]?.turnAdoptionLifecycle?.cronCreatorAuthorityUnavailable).toBe(
      "queued-local-operator",
    );
  });

  it("drains exclusive admission without onAbandoned separately from collectable sources", async () => {
    // Failure window: cancel-only used to be inferred from missing onAbandoned,
    // so exclusive admission without onAbandoned shared collect identity.
    const exclusiveNoAbandon = createRun({ prompt: "exclusive a" });
    exclusiveNoAbandon.turnAdoptionLifecycle = {
      admission: "exclusive",
      onAdopted: async () => {},
    };
    const exclusiveSibling = createRun({ prompt: "exclusive b" });
    exclusiveSibling.turnAdoptionLifecycle = {
      admission: "exclusive",
      onAdopted: async () => {},
    };
    const cancelOnly = createRun({ prompt: "cancel-only" });
    cancelOnly.turnAdoptionLifecycle = {
      admission: "cancel-only",
      ownerKey: "gw:owner",
      onAdopted: async () => {},
    };
    const cancelOnlyShared = createRun({ prompt: "cancel-only shared" });
    cancelOnlyShared.turnAdoptionLifecycle = {
      admission: "cancel-only",
      ownerKey: "gw:owner",
      onAdopted: async () => {},
    };

    const key = "exclusive-without-abandon";
    const { calls, done, runFollowup } = createDrainRecorder(3);
    for (const run of [exclusiveNoAbandon, exclusiveSibling, cancelOnly, cancelOnlyShared]) {
      enqueueFollowupRun(key, run, createQueueSettings());
    }
    await drainRecordedQueue(key, runFollowup, done);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(exclusiveNoAbandon);
    expect(calls[1]).toBe(exclusiveSibling);
    expect(calls[2]?.prompt).toContain("Queued #1\ncancel-only");
    expect(calls[2]?.prompt).toContain("Queued #2\ncancel-only shared");
  });

  it.each(["admission", "abandonment", "abort", "callback failure"] as const)(
    "renews a deeper queued lifecycle until %s",
    async (transition) => {
      vi.useFakeTimers();
      const key = `test-deferred-heartbeat-${transition}`;
      const abort = new AbortController();
      let lastHeartbeat = -Infinity;
      let failHeartbeat = false;
      const heartbeat = vi.fn(() => {
        if (failHeartbeat) {
          throw new Error("heartbeat unavailable");
        }
        lastHeartbeat = Date.now();
      });
      const pending = createRun({ prompt: "deeper queued turn" });
      pending.turnAdoptionLifecycle = {
        admission: "exclusive",
        abortSignal: abort.signal,
        onAdopted: async () => {},
        onDeferredHeartbeat: heartbeat,
        deferredHeartbeatIntervalMs: 1_000,
      };
      try {
        const settings = createQueueSettings({ mode: "followup" });
        enqueueFollowupRun(key, createRun({ prompt: "earlier turn" }), settings);
        enqueueFollowupRun(key, pending, settings);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(Date.now() - lastHeartbeat).toBeLessThan(1_000);
        if (transition === "admission") {
          await admitFollowupRunLifecycle(pending);
        } else {
          failHeartbeat = true;
          await vi.advanceTimersByTimeAsync(1_000);
        }
        const callsAtTransition = heartbeat.mock.calls.length;
        await vi.advanceTimersByTimeAsync(3_000);
        expect(heartbeat).toHaveBeenCalledTimes(callsAtTransition);
        const delivered: string[] = [];
        scheduleFollowupDrain(key, async (run) => {
          await admitFollowupRunLifecycle(run);
          delivered.push(run.prompt);
          completeFollowupRunLifecycle(run);
        });
        await vi.runAllTimersAsync();
        expect(delivered).toEqual(["earlier turn", "deeper queued turn"]);
      } finally {
        clearFollowupQueue(key);
        vi.useRealTimers();
      }
    },
  );

  it.for(["collect", "overflow"] as const)(
    "resumes %s source heartbeats when preparation failure becomes a capacity wait",
    async (mode, { signal }) => {
      vi.useFakeTimers();
      vi.stubEnv("OPENCLAW_TEST_FAST", "0");
      const q = createQueueCase({
        mode: mode === "collect" ? "collect" : "followup",
        cap: mode === "collect" ? 2 : 1,
        debounceMs: 10,
      });
      const releaseAdoption = createDeferred();
      const sources = ["first source", "second source"].map((prompt) => ({
        prompt,
        heartbeat: vi.fn(),
        adopted: vi.fn(async () => {}),
        enqueued: vi.fn(),
      }));
      let attempts = 0;
      let drainReleased: Promise<void> | undefined;
      try {
        for (const source of sources) {
          q.add({
            ...createRun({ prompt: source.prompt, originatingChannel: "webchat" }),
            turnAdoptionLifecycle: {
              admission: "cancel-only",
              onDeferred: source.enqueued,
              onAdopted: source.adopted,
              onDeferredHeartbeat: source.heartbeat,
              deferredHeartbeatIntervalMs: 2,
            },
          });
        }
        if (mode === "overflow") {
          q.add(createRun({ prompt: "live item", originatingChannel: "webchat" }));
        }
        q.start(async (run) => {
          const released = createDeferred();
          captureGatewayRootWorkReleaseObserver()?.(() => released.resolve());
          drainReleased = released.promise;
          if (run.prompt !== "live item") {
            attempts += 1;
            if (attempts === 1) {
              rejectQueuePreparation(run, new Error("ENOSPC: preparation failed"));
            }
            if (attempts === 2) {
              rejectQueuePreparation(run, new FollowupRunDeferredError("reply lane busy"));
            }
            await releaseAdoption.promise;
          }
          await admitFollowupRunLifecycle(run);
          completeFollowupRunLifecycle(run);
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(attempts).toBe(1);
        const stoppedCounts = sources.map((source) => source.heartbeat.mock.calls.length);
        await vi.advanceTimersByTimeAsync(5);
        expect(sources.map((source) => source.heartbeat.mock.calls.length)).toEqual(stoppedCounts);
        await vi.advanceTimersByTimeAsync(15);
        expect(attempts).toBe(3);
        const resumedCounts = sources.map((source) => source.heartbeat.mock.calls.length);
        await vi.advanceTimersByTimeAsync(40);
        for (const [index, source] of sources.entries()) {
          expect(source.heartbeat.mock.calls.length).toBeGreaterThan(resumedCounts[index]!);
          expect(source.enqueued).toHaveBeenCalledOnce();
        }
        releaseAdoption.resolve();
        expect(drainReleased).toBeDefined();
        await withinTest(drainReleased!, signal);
        const adoptedCounts = sources.map((source) => source.heartbeat.mock.calls.length);
        await vi.advanceTimersByTimeAsync(40);
        expect(sources.map((source) => source.heartbeat.mock.calls.length)).toEqual(adoptedCounts);
        for (const source of sources) {
          expect(source.adopted).toHaveBeenCalledOnce();
        }
        expect(getExistingFollowupQueue(q.key)).toBeUndefined();
      } finally {
        releaseAdoption.resolve();
        clearFollowupQueue(q.key);
        await drainReleased;
        vi.unstubAllEnvs();
        vi.useRealTimers();
      }
    },
  );
  it("retries lifecycle admission after a callback rejection", async () => {
    const onAdmitted = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("admission failed"))
      .mockResolvedValueOnce();
    const run = createRun({ prompt: "retry admission" });
    run.turnAdoptionLifecycle = {
      onAdopted: onAdmitted,
      admission: "exclusive",
      onAbandoned: () => {},
    };

    try {
      await expect(admitFollowupRunLifecycle(run)).rejects.toThrow("admission failed");
      await expect(admitFollowupRunLifecycle(run)).resolves.toBeUndefined();
      await expect(admitFollowupRunLifecycle(run)).resolves.toBeUndefined();
      expect(onAdmitted).toHaveBeenCalledTimes(2);
    } finally {
      completeFollowupRunLifecycle(run);
      await expect(run.controllerInput!.settlement.promise).resolves.toBeUndefined();
    }
  });

  it("serializes completion behind rejected admission and blocks later admission", async () => {
    const admissionStarted = createDeferred();
    const releaseAdmission = createDeferred();
    const admissionError = new Error("admission failed");
    const events: string[] = [];
    const onAdmitted = vi.fn(async () => {
      events.push("admission-started");
      admissionStarted.resolve();
      await releaseAdmission.promise;
      events.push("admission-rejected");
      throw admissionError;
    });
    const onComplete = vi.fn(() => {
      events.push("complete");
    });
    const run = createRun({ prompt: "complete during admission" });
    run.turnAdoptionLifecycle = {
      onAdopted: onAdmitted,
      onSettled: onComplete,
      admission: "exclusive",
    };
    const admission = admitFollowupRunLifecycle(run);
    await admissionStarted.promise;
    completeFollowupRunLifecycle(run);
    expect(onComplete).not.toHaveBeenCalled();
    releaseAdmission.resolve();
    await expect(admission).rejects.toBe(admissionError);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    await expect(admitFollowupRunLifecycle(run)).rejects.toThrow(
      "Input completed before source adoption",
    );
    expect(onAdmitted).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["admission-started", "admission-rejected", "complete"]);
  });

  it("does not enqueue when the external lifecycle rejects the run identity", () => {
    const key = `test-rejected-lifecycle-${Date.now()}`;
    const onEnqueued = vi.fn(() => false);
    const run = createRun({ prompt: "duplicate owner" });
    run.turnAdoptionLifecycle = { onAdopted: async () => {}, onDeferred: onEnqueued };
    const enqueued = enqueueFollowupRun(key, run, {
      mode: "followup",
      debounceMs: 10_000,
      cap: 50,
      dropPolicy: "summarize",
    });
    expect(enqueued).toBe(false);
    expect(onEnqueued).toHaveBeenCalledTimes(1);
    expect(getExistingFollowupQueue(key)?.items ?? []).toEqual([]);
    clearFollowupQueue(key);
  });

  it("retires only the failed reservation when enqueue validation throws", async ({ signal }) => {
    const key = `test-enqueue-validation-throw-${Date.now()}`;
    const settings = createQueueSettings({ mode: "followup" });
    const existing = createRun({ prompt: "existing input" });
    const failed = createRun({ prompt: "invalid input" });
    const successor = createRun({ prompt: "subsequent input" });
    const failure = new Error("source validation failed");
    const onAbandoned = vi.fn();
    const onSettled = vi.fn();
    failed.turnAdoptionLifecycle = {
      onAdopted: async () => {},
      onDeferred: () => {
        throw failure;
      },
      onAbandoned,
      onSettled,
    };
    const dispatched: FollowupRun[] = [];
    try {
      expect(enqueueFollowupRun(key, existing, settings, "none", undefined, false)).toBe(true);
      let thrown: unknown;
      try {
        enqueueFollowupRun(key, failed, settings, "none", undefined, false);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(failure);
      expect(getExistingFollowupQueue(key)?.items).toEqual([existing]);
      expect(enqueueFollowupRun(key, successor, settings, "none", undefined, false)).toBe(true);
      scheduleFollowupDrain(key, async (run) => {
        dispatched.push(run);
      });
      await withinTest(
        Promise.all(
          [existing, failed, successor].map((run) => run.controllerInput!.settlement.promise),
        ),
        signal,
      );
      expect(onAbandoned).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(dispatched.map((run) => run.prompt)).toEqual(["existing input", "subsequent input"]);
      expect(dispatched).not.toContain(failed);
    } finally {
      clearFollowupQueue(key);
    }
  });

  it("collects when channel+destination match", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-same-to-${Date.now()}`,
    );

    const receipts: ReplyOperationRunState[] = [{}, {}];
    for (const [index, receipt] of receipts.entries()) {
      const run = createRun({
        prompt: String(index + 1),
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingChatType: "channel",
      });
      run.replyOperationRunStates = [receipt];
      enqueueFollowupRun(key, run, settings);
    }

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.originatingChannel).toBe("slack");
    expect(calls[0]?.originatingTo).toBe("channel:A");
    expect(calls[0]?.originatingChatType).toBe("channel");
    expect(calls[0]?.replyOperationRunStates).toEqual(receipts);
    expect(calls[0]?.replyOperationRunStates?.[0]).toBe(receipts[0]);
    expect(calls[0]?.replyOperationRunStates?.[1]).toBe(receipts[1]);
  });

  it("collects Slack top-level messages when reply anchors are disabled", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-slack-reply-off-${Date.now()}`,
    );

    for (const [prompt, replyToId] of [
      ["one", "101.001"],
      ["two", "101.002"],
    ] as const) {
      enqueueTestRun(
        key,
        {
          prompt,
          messageId: replyToId,
          originatingChannel: "slack",
          originatingTo: "channel:A",
          originatingReplyToId: replyToId,
          originatingReplyToMode: "off",
          originatingChatType: "channel",
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Queued #1\none");
    expect(calls[0]?.prompt).toContain("Queued #2\ntwo");
  });

  it("splits collect batches when enabled reply anchors differ", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-slack-reply-all-${Date.now()}`,
      {},
      2,
    );

    for (const [prompt, replyToId] of [
      ["one", "101.001"],
      ["two", "101.002"],
    ] as const) {
      enqueueTestRun(
        key,
        {
          prompt,
          messageId: replyToId,
          originatingChannel: "slack",
          originatingTo: "channel:A",
          originatingReplyToId: replyToId,
          originatingReplyToMode: "all",
          originatingChatType: "channel",
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.prompt)).toEqual(["one", "two"]);
    expect(calls.map((call) => call.messageId)).toEqual(["101.001", "101.002"]);
  });

  it.each([
    ["first", " Slack "],
    ["batched", "SLACK"],
  ] as const)(
    "splits standalone Slack collect batches by message id in %s reply mode",
    async (replyToMode, originatingChannel) => {
      const { key, calls, done, settings } = createKeyedQueueCase(
        `test-collect-slack-standalone-${replyToMode}-${Date.now()}`,
      );

      for (const [prompt, messageId] of [
        ["one", "101.001"],
        ["two", "101.002"],
      ] as const) {
        enqueueTestRun(
          key,
          {
            prompt,
            messageId,
            originatingChannel,
            originatingTo: "channel:A",
            originatingReplyToMode: replyToMode,
            originatingChatType: "channel",
          },
          settings,
        );
      }

      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        if (calls.length === 2) {
          done.resolve();
        }
      });
      await done.promise;

      expect(calls.map((call) => call.prompt)).toEqual(["one", "two"]);
      expect(calls.map((call) => call.messageId)).toEqual(["101.001", "101.002"]);
    },
  );

  it("keeps history-policy peers separate when delivery targets coincide", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      "history-route-peers",
      {},
      2,
    );
    for (const peerId of ["peer", "direct:peer"]) {
      enqueueSlackRun(key, settings, peerId, { conversationRoutePeerId: peerId });
    }
    await drainRecordedQueue(key, runFollowup, done);
    expect(calls.map((call) => call.run.conversationRoutePeerId)).toEqual(["peer", "direct:peer"]);
    expect(calls.map((call) => call.prompt)).toEqual(["peer", "direct:peer"]);
  });

  it("collects distinct messages inside the same routed thread", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-shared-thread-${Date.now()}`,
    );
    for (const [prompt, messageId] of [
      ["one", "message-1"],
      ["two", "message-2"],
    ] as const) {
      enqueueTestRun(
        key,
        {
          prompt,
          messageId,
          originatingChannel: "telegram",
          originatingTo: "chat:1",
          originatingThreadId: "topic-1",
          originatingReplyToMode: "all",
          originatingChatType: "group",
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Queued #1\none");
    expect(calls[0]?.prompt).toContain("Queued #2\ntwo");
  });

  it.each([
    { disposition: "drop", elided: false },
    { disposition: "deliver", elided: true },
  ] as const)(
    "keeps the WebChat $disposition owner on overflow summaries (elided: $elided)",
    async ({ disposition, elided }) => {
      const q = createQueueCase({ cap: 1 }, elided ? 3 : 2);
      const delivered: string[] = [];
      const sourceDisposition =
        disposition === "deliver"
          ? {
              kind: "deliver" as const,
              deliver: async (batch: { payloads: Array<{ text?: string }> }) => {
                delivered.push(batch.payloads[0]?.text ?? "");
              },
            }
          : { kind: "drop" as const, reason: "source-unavailable" as const };
      const dropped = createRun({
        prompt: "overflowed WebChat message",
        originatingChannel: "webchat",
        originatingChatType: "direct",
      });
      dropped.queuedFollowupReplyDisposition = sourceDisposition;
      q.add(dropped);
      if (elided) {
        q.enqueue({
          prompt: "separate overflow route",
          originatingChannel: "webchat",
          originatingChatType: "group",
        });
      }
      q.enqueue({
        prompt: "live WebChat message",
        originatingChannel: "webchat",
        originatingChatType: elided ? "group" : "direct",
      });
      const expectedCalls = elided ? 3 : 2;
      const unrelatedDispatcher = vi.fn();
      q.start(async (run) => {
        q.calls.push(run);
        if (run.prompt.includes("overflowed WebChat message")) {
          const owner = run.queuedFollowupReplyDisposition;
          if (owner?.kind === "deliver") {
            await owner.deliver({
              kind: "queued-followup",
              completion: { kind: "completed" },
              runId: "overflow-summary-run",
              originatingChannel: "webchat",
              payloads: [{ text: "overflow summary reached its owner" }],
            });
          } else if (owner?.kind !== "drop") {
            unrelatedDispatcher();
          }
        }
        if (q.calls.length >= expectedCalls) {
          q.done.resolve();
        }
      });
      await q.done.promise;
      expect(q.calls[0]?.queuedFollowupReplyDisposition).toBe(sourceDisposition);
      expect(unrelatedDispatcher).not.toHaveBeenCalled();
      expect(delivered).toEqual(
        disposition === "deliver" ? ["overflow summary reached its owner"] : [],
      );
    },
  );

  it("preserves context-isolated summaries after evicting excess metadata", async () => {
    const q = createQueueCase({ cap: 3 }, 6);
    const queued = [
      ["discarded context", "discarded"],
      ["dropped A", "A"],
      ["dropped B", "B"],
      ["dropped C1", "C"],
      ["dropped C2", "C"],
      ["dropped D", "D"],
      ["dropped E", "E"],
      ["survivor 1", "survivor"],
      ["survivor 2", "survivor"],
      ["survivor 3", "survivor"],
    ] as const;
    for (const [prompt, target] of queued) {
      q.enqueue({
        prompt,
        originatingChannel: "slack",
        originatingTo: `channel:${target}`,
        originatingChatType: "channel",
      });
    }
    await q.drain();
    expect(q.calls).toHaveLength(6);
    const overflowPrompts = q.calls.slice(0, 5).map((run) => run.prompt);
    expect(overflowPrompts).toEqual([
      expect.stringContaining("- dropped A"),
      expect.stringContaining("- dropped B"),
      expect.stringMatching(/- dropped C1[\s\S]*- dropped C2/),
      expect.stringContaining("- dropped D"),
      expect.stringContaining("- dropped E"),
    ]);
    expect(overflowPrompts[2]).toContain("Dropped 2 messages");
    expect(q.calls.map((run) => run.prompt).join("\n")).not.toContain("discarded context");
    expect(overflowPrompts.every((prompt) => prompt.includes("Summary:\n- "))).toBe(true);
    expect(q.calls[5]?.prompt).toContain("survivor 1");
    expect(q.calls[5]?.prompt).toContain("survivor 2");
    expect(q.calls[5]?.prompt).toContain("survivor 3");
  });

  it("evicts oldest overflow context metadata when the item cap is reached", () => {
    const key = `test-collect-overflow-elision-bound-${Date.now()}`;
    const settings = createQueueSettings({ cap: 2 });

    const accepted = ["A", "B", "A", "B", "A", "B", "survivor"].map((target, index) =>
      enqueueTestRun(
        key,
        {
          prompt: `message ${index}`,
          originatingChannel: "slack",
          originatingTo: `channel:${target}`,
          originatingChatType: "channel",
        },
        settings,
      ),
    );

    const queue = getExistingFollowupQueue(key);
    expect(accepted).toEqual([true, true, true, true, true, true, true]);
    expect(queue?.summaryElisions.map((entry) => entry.sources.at(-1)?.originatingTo)).toEqual([
      "channel:B",
      "channel:A",
    ]);
    expect(queue?.evictedSummaryCount).toBe(1);
    expect(queue?.items.map((item) => item.originatingTo)).toEqual([
      "channel:B",
      "channel:survivor",
    ]);
    clearFollowupQueue(key);
  });

  it("bounds retained overflow cancellation identities by the item cap", async () => {
    const key = `test-collect-overflow-source-bound-${Date.now()}`;
    const completions = Array.from({ length: 8 }, () => vi.fn());
    const settings = createQueueSettings({ cap: 2 });

    for (const [index, onComplete] of completions.entries()) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({
            prompt: `message ${index}`,
            originatingChannel: "slack",
            originatingTo: "channel:A",
            originatingChatType: "channel",
          }),
          turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
        },
        settings,
      );
    }

    const queue = getExistingFollowupQueue(key);
    expect(queue?.summaryElisions.flatMap((entry) => entry.sources)).toHaveLength(2);
    expect(
      queue?.summaryElisions.flatMap((entry) => entry.sources.map((source) => source.prompt)),
    ).toEqual(["message 2", "message 3"]);
    expect(queue?.evictedSummaryCount).toBe(2);
    await Promise.all(
      queue!.entries
        .filter((input) => input.retirementRequested)
        .map((input) => input.settlement.promise),
    );
    expect(completions.map((onComplete) => onComplete.mock.calls.length)).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0,
    ]);
    clearFollowupQueue(key);
  });

  it("does not register a drop:new source that the full queue rejects", async () => {
    const key = `test-drop-new-lifecycle-${Date.now()}`;

    const onEnqueued = vi.fn();
    const onAbandoned = vi.fn();
    const onDisposition = vi.fn();
    const onComplete = vi.fn();
    const settings = createQueueSettings({ mode: "followup", cap: 1, dropPolicy: "new" });

    expect(enqueueFollowupRun(key, createRun({ prompt: "existing" }), settings)).toBe(true);
    const rejected = createRun({ prompt: "rejected" });
    rejected.onQueueDisposition = onDisposition;
    rejected.turnAdoptionLifecycle = {
      onAdopted: async () => {},
      onDeferred: onEnqueued,
      onAbandoned,
      onSettled: onComplete,
    };
    expect(enqueueFollowupRun(key, rejected, settings)).toBe(false);

    expect(onEnqueued).not.toHaveBeenCalled();
    expect(onDisposition).toHaveBeenCalledWith("queue-cap-new");
    expect(onAbandoned).toHaveBeenCalledOnce();
    await rejected.controllerInput!.settlement.promise;
    expect(onComplete).toHaveBeenCalledOnce();
    expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual(["existing"]);
    clearFollowupQueue(key);
  });

  it("scopes overflow transcript idempotency to the source route", async () => {
    const drainRoute = async (to: string): Promise<FollowupRun[]> => {
      const q = createQueueCase({ cap: 1 }, 2);
      for (const [prompt, messageId] of [
        ["dropped", "provider-local-id"],
        ["survivor", "survivor-id"],
      ] as const) {
        q.enqueue({
          prompt,
          messageId,
          originatingChannel: "slack",
          originatingTo: to,
          originatingAccountId: "workspace",
          originatingThreadId: "thread",
          originatingReplyToId: "reply",
          originatingReplyToMode: "all",
          originatingChatType: "channel",
        });
      }
      const inputs = getExistingFollowupQueue(q.key)!.entries.slice();
      q.start();
      await q.done.promise;
      await Promise.all(inputs.map((input) => input.settlement.promise));
      await inputs.at(-1)?.claim?.settlement.promise;
      return q.calls;
    };
    const firstCalls = await drainRoute("channel:A");
    const secondCalls = await drainRoute("channel:B");
    const firstMessage = firstCalls[0]?.userTurnTranscriptRecorder?.message as
      | { idempotencyKey?: string }
      | undefined;
    const secondMessage = secondCalls[0]?.userTurnTranscriptRecorder?.message as
      | { idempotencyKey?: string }
      | undefined;
    expect(firstCalls[0]?.prompt).toBe(secondCalls[0]?.prompt);
    expect(firstMessage?.idempotencyKey).toMatch(/^followup-overflow:/);
    expect(secondMessage?.idempotencyKey).toMatch(/^followup-overflow:/);
    expect(firstMessage?.idempotencyKey).not.toBe(secondMessage?.idempotencyKey);
  });

  it("drops an aborted split summary before running the surviving item", async () => {
    const q = createQueueCase({ cap: 1 });
    const controller = new AbortController();
    const droppedBase = createRun({
      prompt: "private direct content",
      originatingChannel: "slack",
      originatingTo: "same-target",
      originatingChatType: "direct",
    });
    const canceled: string[] = [];
    const runFollowup = async (run: FollowupRun) => {
      if (isFollowupRunAborted(run)) {
        canceled.push(run.prompt);
        return;
      }
      await q.runFollowup(run);
    };
    const liveBase = createRun({
      prompt: "public channel content",
      originatingChannel: "slack",
      originatingTo: "same-target",
      originatingChatType: "channel",
    });
    for (const source of [
      {
        ...droppedBase,
        abortSignal: controller.signal,
        currentInboundContext: { text: "private runtime context" },
        run: { ...droppedBase.run, model: "old-model", senderId: "guest", senderIsOwner: false },
      },
      {
        ...liveBase,
        run: { ...liveBase.run, model: "old-model", senderId: "owner", senderIsOwner: true },
      },
    ]) {
      enqueueFollowupRun(q.key, source, q.settings, "none", runFollowup, false);
    }
    controller.abort();
    refreshQueuedFollowupSession({ key: q.key, nextModel: "current-model" });
    await q.drain(runFollowup);
    expect(canceled).toEqual(["private direct content"]);
    expect(q.calls).toHaveLength(1);
    expect(q.calls[0]?.run.model).toBe("current-model");
    expect(q.calls[0]?.run.requestedRouteResolution).toBe("raw");
    expect(q.calls[0]?.originatingChatType).toBe("channel");
    expect(q.calls[0]?.run.senderId).toBe("owner");
    expect(q.calls[0]?.run.senderIsOwner).toBe(true);
  });

  it("removes a delivered split summary by source identity after concurrent enqueue", async () => {
    const q = createQueueCase({ cap: 1 }, 1);
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    q.enqueue({
      prompt: "source A",
      originatingChannel: "slack",
      originatingTo: "same-target",
      originatingChatType: "direct",
    });
    q.enqueue({
      prompt: "source B",
      originatingChannel: "slack",
      originatingTo: "same-target",
      originatingChatType: "channel",
    });
    q.start(async (run) => {
      q.calls.push(run);
      if (q.calls.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        return;
      }
      if (q.calls.length >= 3) {
        q.done.resolve();
      }
    });
    await firstStarted.promise;
    q.enqueue({
      prompt: "surviving C",
      originatingChannel: "slack",
      originatingTo: "same-target",
      originatingChatType: "channel",
    });
    releaseFirst.resolve();
    await q.done.promise;
    expect(q.calls[0]?.prompt).toContain("- source A");
    expect(q.calls[0]?.originatingChatType).toBe("direct");
    expect(q.calls[1]?.prompt).toContain("- source B");
    expect(q.calls[1]?.prompt).not.toContain("source A");
    expect(q.calls[1]?.originatingChatType).toBe("channel");
    expect(q.calls[2]?.prompt).toContain("surviving C");
    expect(q.calls[2]?.prompt).not.toContain("source A");
    expect(q.calls[2]?.prompt).not.toContain("source B");
    expect(q.calls[2]?.originatingChatType).toBe("channel");
  });

  it("does not deliver a context group again after concurrent overflow summarizes it", async () => {
    const q = createQueueCase({ cap: 2 }, 1);
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const createContextRun = (prompt: string, chatType: "direct" | "channel") =>
      createRun({
        prompt,
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: chatType,
      });
    q.add(createContextRun("context A", "direct"));
    q.add(createContextRun("context B", "channel"));
    q.start(async (run) => {
      q.calls.push(run);
      if (q.calls.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    });
    await firstStarted.promise;
    q.add(createContextRun("context C", "channel"));
    q.add(createContextRun("context D", "channel"));
    releaseFirst.resolve();
    await vi.waitFor(() => expect(getExistingFollowupQueue(q.key)).toBeUndefined());
    const contextBCalls = q.calls.filter((run) => run.prompt.includes("context B"));
    expect(contextBCalls).toHaveLength(1);
    expect(contextBCalls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
  });

  it("retries split overflow summaries after transient failure", async () => {
    const key = `test-collect-overflow-split-retry-${Date.now()}`;
    const prompts: string[] = [];
    const done = createDeferred();
    const onComplete = vi.fn();
    let attempt = 0;
    const settings = createQueueSettings({ cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({
          prompt: "private source",
          originatingChannel: "slack",
          originatingTo: "same-target",
          originatingChatType: "direct",
        }),
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
      },
      settings,
    );
    enqueueTestRun(
      key,
      {
        prompt: "public survivor",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "channel",
      },
      settings,
    );

    await drainSettledQueue(key, async (run) => {
      attempt += 1;
      prompts.push(run.prompt);
      if (attempt === 1) {
        rejectQueuePreparation(run, new Error("transient summary preparation failure"));
      }
      if (attempt >= 3) {
        done.resolve();
      }
    });

    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("- private source");
    expect(prompts[1]).toContain("- private source");
    expect(prompts[2]).toContain("public survivor");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("keeps overflow summary text paired with its source route", async () => {
    const { key, calls, done, settings } = createKeyedQueueCase(
      `test-collect-overflow-deferred-pairs-${Date.now()}`,
      { cap: 1 },
    );

    enqueueTestRuns(
      key,
      settings,

      {
        prompt: "source A",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "direct",
      },
      {
        prompt: "source B",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "direct",
      },
    );

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        enqueueTestRun(
          key,
          {
            prompt: "surviving C",
            originatingChannel: "slack",
            originatingTo: "same-target",
            originatingChatType: "channel",
          },
          settings,
        );
        return;
      }
      if (calls.length >= 3) {
        done.resolve();
      }
    });
    await done.promise;

    expect(calls[1]?.prompt).toContain("- source B");
    expect(calls[1]?.prompt).not.toContain("source A");
    expect(calls[1]?.originatingChatType).toBe("direct");
    expect(calls[2]?.prompt).toContain("surviving C");
    expect(calls[2]?.prompt).not.toContain("source A");
    expect(calls[2]?.prompt).not.toContain("source B");
    expect(calls[2]?.originatingChatType).toBe("channel");
  });

  it("collects compatible items after one cross-channel drain", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-after-cross-${Date.now()}`,
      {},
      2,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "first route",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      },
      {
        prompt: "second route one",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      },
      {
        prompt: "second route two",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("first route");
    expect(calls[1]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[1]?.prompt).toContain("Queued #1\nsecond route one");
    expect(calls[1]?.prompt).toContain("Queued #2\nsecond route two");
    expect(calls[1]?.originatingChannel).toBe("slack");
    expect(calls[1]?.originatingTo).toBe("channel:B");
  });

  it("drains unresolved-origin items separately from a routed batch", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-unresolved-origin-${Date.now()}`,
      {},
      2,
    );

    enqueueTestRun(key, { prompt: "unresolved origin" }, settings);
    enqueueRoutedRuns(
      key,
      settings,
      { originatingChannel: "slack", originatingTo: "channel:B", originatingChatType: "channel" },
      "keyed one",
      "keyed two",
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("unresolved origin");
    expect(calls[0]?.prompt).not.toContain("keyed one");
    expect(calls[0]?.originatingChannel).toBeUndefined();
    expect(calls[1]?.prompt).toContain("Queued #1\nkeyed one");
    expect(calls[1]?.prompt).toContain("Queued #2\nkeyed two");
    expect(calls[1]?.originatingChannel).toBe("slack");
    expect(calls[1]?.originatingTo).toBe("channel:B");
    expect(calls[1]?.originatingChatType).toBe("channel");
  });

  it("does not collect known route-less chat types into another destination", async () => {
    const q = createQueueCase({}, 2);
    q.enqueueMany(
      { prompt: "unresolved direct", originatingChatType: "direct" },
      {
        prompt: "channel one",
        originatingChannel: "slack",
        originatingTo: "channel:B",
        originatingChatType: "channel",
      },
      {
        prompt: "channel two",
        originatingChannel: "slack",
        originatingTo: "channel:B",
        originatingChatType: "channel",
      },
    );
    await q.drain();
    expect(q.calls[0]?.prompt).toBe("unresolved direct");
    expect(q.calls[0]?.originatingChatType).toBe("direct");
    expect(q.calls[1]?.prompt).toContain("channel one");
    expect(q.calls[1]?.prompt).toContain("channel two");
    expect(q.calls[1]?.prompt).not.toContain("unresolved direct");
    expect(q.calls[1]?.originatingChatType).toBe("channel");
  });

  it("drains a disableCollectBatching retry individually instead of collecting it", async () => {
    const strandedReplyRetryMarker = "stranded-reply-retry";
    const q = createQueueCase({}, 3);
    const route = { originatingChannel: "slack" as const, originatingTo: "channel:A" };
    const retryPrompt = "[System] Please deliver this reply now by calling message(action=send).";
    q.add(createRun({ prompt: "normal one", ...route }));
    q.add({
      ...createRun({ prompt: retryPrompt, ...route }),
      summaryLine: strandedReplyRetryMarker,
      disableCollectBatching: true,
    });
    q.add(createRun({ prompt: "normal two", ...route }));
    await q.drain();
    expect(q.calls).toHaveLength(3);
    const retryCall = q.calls.find((call) => call.prompt === retryPrompt);
    expect(retryCall).toBeDefined();
    expect(retryCall?.prompt).not.toContain("[Queued messages while agent was busy]");
    expect(retryCall?.prompt).not.toContain("Queued #");
    expect(retryCall?.summaryLine).toBe(strandedReplyRetryMarker);
    for (const call of q.calls) {
      if (call.prompt.includes(retryPrompt)) {
        expect(call.prompt).not.toContain("normal one");
        expect(call.prompt).not.toContain("normal two");
      }
    }
  });

  it("drains priority followups before already queued items", async () => {
    const key = `test-priority-followup-front-${Date.now()}`;
    const settings = createQueueSettings({ mode: "followup" });

    enqueueFollowupRun(key, createRun({ prompt: "queued later one" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "queued later two" }), settings);
    enqueueFollowupRun(
      key,
      createRun({ prompt: "priority retry" }),
      settings,
      "none",
      undefined,
      false,
      { position: "front" },
    );

    const { calls, done, runFollowup } = createDrainRecorder(3);
    await drainRecordedQueue(key, runFollowup, done);
    expect(calls.map((item) => item.prompt)).toEqual([
      "priority retry",
      "queued later one",
      "queued later two",
    ]);
    expect(calls[0]?.protectFromQueueOverflow).toBe(true);
  });

  it("preserves prepended priority followups during old-item overflow eviction", () => {
    const key = `test-priority-followup-overflow-${Date.now()}`;
    const settings = createQueueSettings({ mode: "followup", cap: 2, dropPolicy: "old" });

    enqueueFollowupRun(key, createRun({ prompt: "queued later one" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "queued later two" }), settings);
    enqueueFollowupRun(
      key,
      createRun({ prompt: "priority retry" }),
      settings,
      "none",
      undefined,
      false,
      { position: "front" },
    );
    enqueueFollowupRun(key, createRun({ prompt: "queued later three" }), settings);

    expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
      "priority retry",
      "queued later three",
    ]);
  });

  it("keeps a cap-one protected priority followup instead of evicting it", () => {
    const key = `test-priority-followup-cap-one-${Date.now()}`;
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    const priorityAccepted = enqueueFollowupRun(
      key,
      createRun({ prompt: "priority retry" }),
      settings,
      "none",
      undefined,
      false,
      { position: "front" },
    );
    const normalAccepted = enqueueFollowupRun(
      key,
      createRun({ prompt: "normal after priority" }),
      settings,
    );

    expect(priorityAccepted).toBe(true);
    expect(normalAccepted).toBe(false);
    expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
      "priority retry",
    ]);
    expect(getExistingFollowupQueue(key)?.summarySources).toHaveLength(0);
  });

  it("does not advance debounce stamp when overflow rejects an incoming message", () => {
    const key = `test-priority-followup-debounce-reject-${Date.now()}`;
    const settings = createQueueSettings({
      mode: "followup",
      debounceMs: 5_000,
      cap: 1,
      dropPolicy: "old",
    });

    const priorityAccepted = enqueueFollowupRun(
      key,
      createRun({ prompt: "priority retry" }),
      settings,
      "none",
      undefined,
      false,
      { position: "front" },
    );
    const queue = getExistingFollowupQueue(key);
    expect(priorityAccepted).toBe(true);
    expect(queue).toBeDefined();
    const stampedAt = queue!.lastEnqueuedAt;
    expect(stampedAt).toBeGreaterThan(0);

    const rejected = enqueueFollowupRun(key, createRun({ prompt: "busy chat noise" }), settings);
    expect(rejected).toBe(false);
    expect(getExistingFollowupQueue(key)?.lastEnqueuedAt).toBe(stampedAt);
    expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
      "priority retry",
    ]);
  });

  it("leaves the queue untouched when protected overflow cannot drop enough items", () => {
    const key = `test-priority-followup-atomic-overflow-${Date.now()}`;
    const initialSettings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 3,
      dropPolicy: "summarize",
    };
    const shrunkSettings: QueueSettings = { ...initialSettings, cap: 1 };
    enqueueFollowupRun(
      key,
      createRun({ prompt: "priority retry" }),
      initialSettings,
      "none",
      undefined,
      false,
      { position: "front" },
    );
    enqueueFollowupRun(key, createRun({ prompt: "normal one" }), initialSettings);
    enqueueFollowupRun(key, createRun({ prompt: "normal two" }), initialSettings);
    const accepted = enqueueFollowupRun(
      key,
      createRun({ prompt: "normal after shrink" }),
      shrunkSettings,
    );
    expect(accepted).toBe(false);
    expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
      "priority retry",
      "normal one",
      "normal two",
    ]);
    expect(getExistingFollowupQueue(key)?.summarySources).toHaveLength(0);
    expect(getExistingFollowupQueue(key)?.summaryLines).toHaveLength(0);
  });

  it("drains protected priority followups before overflow summaries", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 }, 2);
    q.add(createRun({ prompt: "overflowed normal" }));
    enqueueFollowupRun(
      q.key,
      createRun({ prompt: "priority retry" }),
      q.settings,
      "none",
      undefined,
      false,
      { position: "front" },
    );
    await q.drain();
    expect(q.calls).toHaveLength(2);
    expect(q.calls[0]?.prompt).toBe("priority retry");
    expect(q.calls[1]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(q.calls[1]?.prompt).toContain("- overflowed normal");
  });

  it("preserves prepared media through elided overflow and collected execution", async () => {
    const q = createQueueCase({ cap: 1 });
    for (const [index, prompt] of ["first", "second", "survivor"].entries()) {
      const source: InternalFollowupRun = {
        ...createRun({ prompt, originatingChannel: "slack", originatingTo: "channel:A" }),
        currentTurnImagesPrepared: true,
        images: [],
        imageOrder: ["offloaded"],
        media: [
          { path: `/tmp/offloaded-${index}.png`, contentType: "image/png" },
          {
            path: `/tmp/missing-${index}.png`,
            contentType: "image/png",
            hydrationSuppressed: true,
          },
        ],
        mediaImageLayout: {
          slots: [{ kind: "offloaded", factIndex: 0 }],
          suppressedFactIndexes: [1],
        },
      };
      q.add(source);
    }
    await drainSettledQueue(q.key, q.runFollowup);
    expect(q.calls).toHaveLength(2);
    const collected: InternalFollowupRun | undefined = q.calls[0];
    expect(collected?.prompt).toContain("Dropped 2 messages");
    expect(collected?.prompt).toContain("second");
    expect(collected?.currentTurnImagesPrepared).toBe(true);
    expect(collected?.images).toEqual([]);
    expect(collected?.imageOrder).toEqual(["offloaded", "offloaded"]);
    expect(collected?.media?.map((fact) => fact.path)).toEqual([
      "/tmp/offloaded-0.png",
      "/tmp/missing-0.png",
      "/tmp/offloaded-1.png",
      "/tmp/missing-1.png",
    ]);
    expect(collected?.mediaImageLayout).toEqual({
      slots: [
        { kind: "offloaded", factIndex: 0 },
        { kind: "offloaded", factIndex: 2 },
      ],
      suppressedFactIndexes: [1, 3],
    });
    expect(q.calls[1]?.prompt).toBe("survivor");
  });

  it("offsets prepared media layout fact indexes across collected batches", async () => {
    const q = createQueueCase();
    for (const [index, prompt] of ["one", "two"].entries()) {
      const preparedRun: InternalFollowupRun = {
        ...createRun({ prompt, originatingChannel: "slack", originatingTo: "channel:A" }),
        currentTurnImagesPrepared: true,
        images: [],
        imageOrder: ["offloaded"],
        media: [
          { path: `/tmp/offloaded-${index}.png`, contentType: "image/png" },
          {
            path: `/tmp/missing-${index}.png`,
            contentType: "image/png",
            hydrationSuppressed: true,
          },
        ],
        mediaImageLayout: {
          slots: [{ kind: "offloaded", factIndex: 0 }],
          suppressedFactIndexes: [1],
        },
      };
      q.add(preparedRun);
    }
    await q.drain();
    expect(q.calls[0]?.currentTurnImagesPrepared).toBe(true);
    expect(q.calls[0]?.images).toEqual([]);
    expect((q.calls[0] as InternalFollowupRun | undefined)?.mediaImageLayout).toEqual({
      slots: [
        { kind: "offloaded", factIndex: 0 },
        { kind: "offloaded", factIndex: 2 },
      ],
      suppressedFactIndexes: [1, 3],
    });
  });

  it("splits collect batches when sender authorization changes", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-auth-split-${Date.now()}`,
      {},
      2,
    );

    enqueueSlackRun(key, settings, "use the gateway tool", {
      senderId: "user-1",
      senderName: "Guest",
      senderIsOwner: false,
    });
    enqueueSlackRun(key, settings, "what's the weather?", {
      senderId: "owner-1",
      senderName: "Owner",
      senderIsOwner: true,
    });

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.run.senderIsOwner)).toEqual([false, true]);
    expect(calls[0]?.prompt).toContain("use the gateway tool");
    expect(calls[0]?.prompt).not.toContain("what's the weather?");
    expect(calls[1]?.prompt).toContain("what's the weather?");
    expect(calls[1]?.run.senderName).toBe("Owner");
  });

  it("preserves sender-scoped batching while identity collection is disabled", async () => {
    const audit = createChannelAdmissionAudit({ enabled: false });
    try {
      const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
        `test-collect-identity-disabled-${Date.now()}`,
        {},
        2,
      );
      for (const senderId of ["user-1", "user-2"]) {
        const item = createRun({
          prompt: `from ${senderId}`,
          originatingChannel: "slack",
          originatingTo: "channel:A",
        });
        enqueueFollowupRun(
          key,
          {
            ...item,
            channelAdmissionEvidence: createChannelParticipantAdmissionEvidence({
              audit,
              channelId: "slack",
              participantId: senderId,
            }),
            run: { ...item.run, senderId, senderIsOwner: false },
          },
          settings,
        );
      }

      await drainRecordedQueue(key, runFollowup, done);
      await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());

      expect(calls.map((call) => call.run.senderId)).toEqual(["user-1", "user-2"]);
    } finally {
      audit.close();
    }
  });

  it("keeps same-participant evidence for a collected batch", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const sameCase = createKeyedQueueCase(`test-collect-identity-same-${Date.now()}`);
      for (const prompt of ["same one", "same two"]) {
        const item = createRun({
          prompt,
          originatingChannel: "slack",
          originatingTo: "channel:A",
        });
        enqueueFollowupRun(
          sameCase.key,
          {
            ...item,
            channelAdmissionEvidence: createChannelParticipantAdmissionEvidence({
              audit,
              channelId: "slack",
              accountId: "default",
              participantId: "user-1",
            }),
            run: { ...item.run, senderId: "user-1", senderIsOwner: false },
          },
          sameCase.settings,
        );
      }
      await drainRecordedQueue(sameCase.key, sameCase.runFollowup, sameCase.done);
      await vi.waitFor(() => expect(getExistingFollowupQueue(sameCase.key)).toBeUndefined());
      expect(sameCase.calls).toHaveLength(1);
      expect(sameCase.calls[0]?.run.senderId).toBe("user-1");
      expect(
        consumeChannelAdmissionEvidence(sameCase.calls[0]?.channelAdmissionEvidence),
      ).toMatchObject({
        ingressState: "present",
        invoker: { state: "present", kind: "person" },
      });
    } finally {
      audit.close();
    }
  });

  it("splits collect batches when queued cancellation owners differ", async () => {
    const q = createQueueCase({ mode: "collect", debounceMs: 0 }, 2);
    for (const [prompt, ownerKey] of [
      ["first", "connection:one"],
      ["second", "connection:two"],
    ] as const) {
      q.add({
        ...createRun({ prompt, originatingChannel: "webchat", originatingTo: "session:main" }),
        turnAdoptionLifecycle: { onAdopted: async () => {}, ownerKey },
      });
    }
    await q.drain();
    expect(q.calls).toHaveLength(2);
    expect(q.calls[0]?.prompt).toContain("first");
    expect(q.calls[0]?.prompt).not.toContain("second");
    expect(q.calls[1]?.prompt).toContain("second");
    expect(q.calls[1]?.prompt).not.toContain("first");
  });

  it("splits collect batches when exec context changes", async () => {
    const q = createQueueCase({}, 2);
    q.slack("first", {
      senderId: "owner-1",
      senderIsOwner: true,
      bashElevated: { enabled: false, allowed: true, defaultLevel: "off" },
    });
    q.slack("second", {
      senderId: "owner-1",
      senderIsOwner: true,
      bashElevated: { enabled: true, allowed: true, defaultLevel: "on" },
      execOverrides: { ask: "always" },
    });

    await q.drain();
    expect(q.calls[0]?.prompt).toContain("first");
    expect(q.calls[0]?.prompt).not.toContain("second");
    expect(q.calls[1]?.prompt).toContain("second");
    expect(q.calls[1]?.run.bashElevated?.enabled).toBe(true);
    expect(q.calls[1]?.run.execOverrides?.ask).toBe("always");
  });

  it("uses the newest run within a matching authorization batch", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-latest-run-${Date.now()}`,
    );

    const run = { provider: "openai", model: "gpt-5.4", senderId: "user-1", senderIsOwner: false };
    enqueueSlackRun(
      key,
      settings,
      "first",
      { ...run, senderName: "First Name" },
      { originatingTo: "A" },
    );
    enqueueSlackRun(
      key,
      settings,
      "second",
      { ...run, senderName: "Newest Name" },
      { originatingTo: "A" },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.run.provider).toBe("openai");
    expect(calls[0]?.run.model).toBe("gpt-5.4");
    expect(calls[0]?.run.senderName).toBe("Newest Name");
  });

  it("delivers summary-only collect work under its source route", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-summary-only-${Date.now()}`,
      { cap: 2 },
      3,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "first",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      },
      {
        prompt: "second",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      },
      {
        prompt: "third",
        originatingChannel: "slack",
        originatingTo: "channel:C",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- first");
    expect(calls[0]?.originatingTo).toBe("channel:A");
    expect(calls[1]?.prompt).toBe("second");
    expect(calls[2]?.prompt).toBe("third");
  });

  it("preserves collect order when authorization changes more than once", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-auth-order-${Date.now()}`,
      {},
      3,
    );

    const route = { originatingTo: "A" };
    const guest = { senderId: "user-a", senderName: "A", senderIsOwner: false };
    enqueueSlackRun(key, settings, "first", guest, route);
    enqueueSlackRun(
      key,
      settings,
      "second",
      { senderId: "owner-1", senderName: "Owner", senderIsOwner: true },
      route,
    );
    enqueueSlackRun(key, settings, "third", guest, route);

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.prompt)).toEqual(["first", "second", "third"]);
    expect(calls.map((call) => [call.run.senderId, call.run.senderIsOwner])).toEqual([
      ["user-a", false],
      ["owner-1", true],
      ["user-a", false],
    ]);
  });

  it("collects Slack messages in same thread and preserves string thread id", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-slack-thread-same-${Date.now()}`,
    );

    enqueueRoutedRuns(
      key,
      settings,
      {
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      },
      "one",
      "two",
    );

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
  });

  it("collects messages when numeric and string thread ids share the route key", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-thread-normalized-${Date.now()}`,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "one",
        originatingChannel: "telegram",
        originatingTo: "-100123",
        originatingThreadId: 42.9,
      },
      {
        prompt: "two",
        originatingChannel: "telegram",
        originatingTo: "-100123",
        originatingThreadId: "42",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.prompt).toContain("one");
    expect(calls[0]?.prompt).toContain("two");
  });

  it("collects matching local webchat routes with distinct message ids", async () => {
    const key = `test-collect-local-webchat-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder();
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "one",
        messageId: "webchat-message-1",
        originatingChannel: "webchat",
        originatingReplyToMode: "all",
      },
      {
        prompt: "two",
        messageId: "webchat-message-2",
        originatingChannel: "webchat",
        originatingReplyToMode: "all",
      },
    );
    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("one");
    expect(calls[0]?.prompt).toContain("two");
  });

  it("does not collect Slack messages when thread ids differ", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-collect-slack-thread-diff-${Date.now()}`,
      {},
      2,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      },
      {
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000002",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls[0]?.prompt).toBe("one");
    expect(calls[1]?.prompt).toBe("two");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
    expect(calls[1]?.originatingThreadId).toBe("1706000000.000002");
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const key = `test-collect-retry-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        rejectQueuePreparation(run, new Error("transient preparation failure"));
      }
      calls.push(run);
      done.resolve();
    };
    const settings = createQueueSettings();

    enqueueFollowupRun(key, createRun({ prompt: "one" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "two" }), settings);

    await drainSettledQueue(key, runFollowup);
    expect(calls[0]?.prompt).toContain("Queued #1\none");
    expect(calls[0]?.prompt).toContain("Queued #2\ntwo");
  });

  it("retries only the remaining collect auth groups after a partial failure", async () => {
    const key = `test-collect-partial-retry-${Date.now()}`;
    const attempts: FollowupRun[] = [];
    const successfulCalls: FollowupRun[] = [];
    const done = createDeferred();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      attempts.push(run);
      if (attempt === 2) {
        rejectQueuePreparation(run, new Error("transient preparation failure"));
      }
      successfulCalls.push(run);
      if (attempt >= 3) {
        done.resolve();
      }
    };
    const settings = createQueueSettings();

    enqueueSlackRun(key, settings, "guest message", {
      senderId: "user-1",
      senderName: "Guest",
      senderIsOwner: false,
    });
    enqueueSlackRun(key, settings, "owner message", {
      senderId: "owner-1",
      senderName: "Owner",
      senderIsOwner: true,
    });

    await drainSettledQueue(key, runFollowup);

    const guestAttempts = attempts.filter((call) => call.prompt.includes("guest message"));
    const ownerAttempts = attempts.filter((call) => call.prompt.includes("owner message"));

    expect(attempts).toHaveLength(3);
    expect(guestAttempts).toHaveLength(1);
    expect(ownerAttempts).toHaveLength(2);
    expect(successfulCalls.map((call) => call.prompt)).toEqual(["guest message", "owner message"]);
  });

  it("persists overflow summaries to the session selected after queue admission", async () => {
    const tempDir = sessionDirs.make();
    const storePath = path.join(tempDir, "sessions.json");
    const oldTranscriptPath = path.join(tempDir, "old-session.jsonl");
    const q = createQueueCase({ mode: "followup", cap: 1 });
    try {
      await replaceSessionEntry(
        { storePath, sessionKey: "agent:agent:main" },
        { sessionId: "new-session", updatedAt: Date.now() },
      );
      const first = createRun({ prompt: "first" });
      first.run.sessionId = "old-session";
      first.run.sessionKey = "agent:agent:main";
      first.run.sessionFile = oldTranscriptPath;
      first.run.config = { session: { store: storePath } };
      const second = createRun({ prompt: "second" });
      second.run = first.run;
      q.add(first);
      q.add(second);
      q.start(async (run) => {
        q.calls.push(run);
        q.done.resolve();
      });
      await q.done.promise;
      const recorder = q.calls[0]?.userTurnTranscriptRecorder;
      expect(recorder).toBeDefined();
      const persisted = await recorder?.persistFallback();
      expect(persisted?.sessionFile).toBe("agent:agent:main");
      await expect(
        loadTranscriptEvents({
          agentId: "agent",
          sessionId: "new-session",
          sessionKey: "agent:agent:main",
          storePath,
        }),
      ).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            content: expect.stringContaining("[Queue overflow] Dropped 1 message due to cap."),
          }),
          type: "message",
        }),
      );
      await expect(fs.stat(oldTranscriptPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearFollowupQueue(q.key);
    }
  });

  it("keeps overflow summaries when aborts remove only the live item", async () => {
    const key = `test-overflow-summary-aborted-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const cleaned: FollowupRun[] = [];
    const settings = createQueueSettings({ mode: "followup", cap: 1 });
    const controller = new AbortController();
    const onComplete = vi.fn();

    enqueueFollowupRun(key, createRun({ prompt: "dropped" }), settings);
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "aborted" }),
        abortSignal: controller.signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
      },
      settings,
    );
    controller.abort();

    await drainSettledQueue(key, async (run) => {
      if (run.abortSignal?.aborted) {
        cleaned.push(run);
        return;
      }
      calls.push(run);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("- dropped");
    expect(cleaned).toEqual([]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  });

  it("does not re-deliver overflow summary on partial auth group failure retry", async () => {
    const q = createQueueCase({ cap: 2 }, 1);
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1; // Summary succeeds (attempt 1), first group fails (attempt 2), then
      // both retained authorization groups succeed on retry.
      if (attempt === 2) {
        rejectQueuePreparation(run, new Error("transient preparation failure"));
      }
      q.calls.push(run);
      if (q.calls.length >= 3) {
        q.done.resolve();
      }
    };
    const guest = { senderId: "user-1", senderName: "Guest", senderIsOwner: false };
    q.slack("dropped guest message", guest);
    q.slack("guest message", guest);
    q.slack("owner message", {
      senderId: "owner-1",
      senderName: "Owner",
      senderIsOwner: true,
    });

    await q.drain(runFollowup);

    expect(q.calls).toHaveLength(3);
    expect(q.calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(q.calls[0]?.prompt).toContain("- dropped guest message");
    expect(q.calls[1]?.prompt).not.toContain("[Queue overflow]");
    expect(q.calls[1]?.prompt).not.toContain("dropped guest message");
    expect(q.calls[1]?.prompt).toContain("guest message");
    expect(q.calls[2]?.prompt).not.toContain("[Queue overflow]");
    expect(q.calls[2]?.prompt).toContain("owner message");
  });

  it("preserves routing metadata on overflow summary followups", async () => {
    const { key, calls, done, runFollowup, settings } = createKeyedQueueCase(
      `test-overflow-summary-routing-${Date.now()}`,
      { mode: "followup", cap: 1 },
    );

    enqueueRoutedRuns(
      key,
      settings,
      {
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      },
      "first",
      "second",
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls[0]?.originatingChannel).toBe("discord");
    expect(calls[0]?.originatingTo).toBe("channel:C1");
    expect(calls[0]?.originatingAccountId).toBe("work");
    expect(calls[0]?.originatingThreadId).toBe("1739142736.000100");
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
  });

  it("keeps live item runtime metadata out of standalone overflow summaries", async () => {
    const q = createQueueCase({ cap: 1 }, 1);
    const controller = new AbortController();
    const onComplete = vi.fn();
    const end = vi.fn();
    const summaryEnd = vi.fn();
    const begin = vi.fn(() => end);
    const summaryBegin = vi.fn(() => summaryEnd);
    const runFollowup = async (run: FollowupRun) => {
      q.calls.push(run);
      expect(run.deliveryCorrelations).toHaveLength(1);
      run.deliveryCorrelations?.[0]?.begin()?.({ visibleReplySent: true, failed: false });
      expect(summaryBegin).toHaveBeenCalledOnce();
      expect(begin).toHaveBeenCalledTimes(q.calls.length - 1);
      if (q.calls.length >= 2) {
        q.done.resolve();
      }
    };
    q.add({
      ...createRun({ prompt: "dropped ambient" }),
      deliveryCorrelations: [{ begin: summaryBegin }],
      currentInboundEventKind: "room_event",
      currentInboundContext: { text: "dropped context" },
    });
    q.add({
      ...createRun({ prompt: "live ambient" }),
      currentInboundEventKind: "room_event",
      currentInboundAudio: true,
      currentInboundContext: { text: "live context" },
      abortSignal: controller.signal,
      deliveryCorrelations: [{ begin }],
      turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
    });
    await q.drain(runFollowup);
    expect(q.calls).toHaveLength(2);
    expect(q.calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(q.calls[0]?.currentInboundEventKind).toBe("room_event");
    expect(q.calls[0]?.currentInboundContext).toBeUndefined();
    expect(q.calls[0]?.abortSignal).toBeUndefined();
    expect(summaryEnd).toHaveBeenCalledExactlyOnceWith({ visibleReplySent: true, failed: false });
    expect(q.calls[1]?.prompt).toBe("live ambient");
    expect(q.calls[1]?.currentInboundEventKind).toBe("room_event");
    expect(q.calls[1]?.currentInboundAudio).toBe(true);
    expect(q.calls[1]?.currentInboundContext?.text).toBe("live context");
    expect(q.calls[1]?.abortSignal).toBe(controller.signal);
    expect(q.calls[1]?.turnAdoptionLifecycle?.onSettled).toBe(onComplete);
    expect(end).toHaveBeenCalledExactlyOnceWith({ visibleReplySent: true, failed: false });
  });

  it.for(["collect", "followup"] as const)(
    "retries distinct %s admission owners independently",
    async (mode, { signal }) => {
      const q = createQueueCase({ mode, cap: mode === "followup" ? 1 : 50 }, 1);
      const events: string[] = [];
      const first = createRun({ prompt: "first" });
      first.turnAdoptionLifecycle = {
        admission: "exclusive",
        onAdopted: async () => {
          events.push("first-admitted");
        },
      };
      const second = createRun({ prompt: "second" });
      second.turnAdoptionLifecycle = {
        admission: "exclusive",
        onAdopted: vi.fn(async () => {
          events.push("second-admitted");
        }),
      };
      let secondAttempts = 0;
      q.add(first);
      q.add(second);
      if (mode === "followup") {
        q.add(createRun({ prompt: "live followup" }));
      }
      try {
        q.start(async (run) => {
          if (run.prompt === "live followup") {
            events.push("live-followup");
            q.done.resolve();
            return;
          }
          const label = run.prompt.includes("first") ? "first" : "second";
          events.push(`run:${label}`);
          try {
            if (label === "second" && secondAttempts++ === 0) {
              events.push("second-rejected");
              rejectQueuePreparation(run, new Error("second preparation failed"));
            }
            await admitFollowupRunLifecycle(run);
          } catch (error) {
            events.push(`error:${label}`);
            throw error;
          }
          events.push(`model:${label}`);
          if (label === "second" && mode === "collect") {
            q.done.resolve();
          }
        });
        await withinTest(q.done.promise, signal);
        expect(events).toEqual([
          "run:first",
          "first-admitted",
          "model:first",
          "run:second",
          "second-rejected",
          "error:second",
          "run:second",
          "second-admitted",
          "model:second",
          ...(mode === "followup" ? ["live-followup"] : []),
        ]);
        expect(second.turnAdoptionLifecycle.onAdopted).toHaveBeenCalledOnce();
      } finally {
        clearFollowupQueue(q.key);
      }
    },
  );

  it.for(["before", "after"] as const)(
    "does not replay a collected source admitted %s a sibling rejects",
    async (admittedWhen, { signal }) => {
      vi.useFakeTimers();
      const q = createQueueCase({ mode: "collect", debounceMs: 0 }, 1);
      const releaseFirstAdmission = createDeferred();
      const secondRejected = createDeferred();
      const failure = new Error("second admission failed");
      const errors: unknown[] = [];
      const firstComplete = vi.fn();
      const secondComplete = vi.fn();
      const first = createRun({ prompt: "first" });
      first.turnAdoptionLifecycle = {
        admission: "cancel-only",
        onAdopted: vi.fn(async () => {
          if (admittedWhen === "after") {
            await releaseFirstAdmission.promise;
          }
        }),
        onSettled: firstComplete,
      };
      const second = createRun({ prompt: "second" });
      second.turnAdoptionLifecycle = {
        admission: "cancel-only",
        onAdopted: vi
          .fn<() => Promise<void>>()
          .mockImplementationOnce(async () => {
            secondRejected.resolve();
            throw failure;
          })
          .mockResolvedValueOnce(),
        onSettled: secondComplete,
      };
      q.add(first);
      q.add(second);
      const settlements = [first, second].map(
        (source) => source.controllerInput!.settlement.promise,
      );
      try {
        q.start(async (run) => {
          q.calls.push(run);
          try {
            await admitFollowupRunLifecycle(run);
          } catch (error) {
            errors.push(error);
            throw error;
          }
        });
        await withinTest(secondRejected.promise, signal);
        // Drain the first rejection while a late successful admission remains blocked.
        await vi.advanceTimersByTimeAsync(0);
        releaseFirstAdmission.resolve();
        await withinTest(Promise.all(settlements), signal);

        expect(errors).toHaveLength(1);
        expect(errors[0]).toBe(failure);
        expect(q.calls).toHaveLength(2);
        expect(q.calls[0]?.prompt).toContain("first");
        expect(q.calls[0]?.prompt).toContain("second");
        expect(q.calls[1]?.prompt).not.toContain("first");
        expect(q.calls[1]?.prompt).toBe("second");
        expect(first.turnAdoptionLifecycle.onAdopted).toHaveBeenCalledTimes(1);
        expect(second.turnAdoptionLifecycle.onAdopted).toHaveBeenCalledTimes(2);
        expect(firstComplete).toHaveBeenCalledOnce();
        expect(secondComplete).toHaveBeenCalledOnce();
      } finally {
        releaseFirstAdmission.resolve();
        clearFollowupQueue(q.key);
        await Promise.allSettled(settlements);
        vi.useRealTimers();
      }
    },
  );

  it("does not treat an undefined callback rejection as an adoption refusal", async () => {
    const q = createQueueCase({ mode: "followup", debounceMs: 0 }, 1);
    const source = createRun({ prompt: "generic failure" });
    q.add(source);
    const rejectUndefined = vi.fn<() => Promise<never>>().mockRejectedValue(undefined);
    q.start(async (run) => {
      q.calls.push(run);
      await rejectUndefined();
    });

    await expect(source.controllerInput!.settlement.promise).resolves.toBeUndefined();
    expect(q.calls).toHaveLength(1);
    expect(getExistingFollowupQueue(q.key)).toBeUndefined();
  });

  it("keeps queue-case cancellation connected after collect admission", async () => {
    const q = createQueueCase({ mode: "collect", debounceMs: 0 }, 1);
    q.add(createRun({ prompt: "first" }));
    q.add(createRun({ prompt: "second" }));
    q.start(async (run) => {
      expect(run.abortSignal).toBeUndefined();
      expect(run.queueAbortSignal?.aborted).toBe(false);
      await run.turnAdoptionLifecycle?.onAdopted?.();
      clearFollowupQueue(q.key);
      expect(run.queueAbortSignal?.aborted).toBe(true);
      q.done.resolve();
    });
    await q.done.promise;
  });

  it.for(["collect", "overflow"] as const)(
    "does not replay accepted %s sources after a sibling adoption times out",
    async (mode, { signal }) => {
      const q = createQueueCase({
        mode: mode === "collect" ? "collect" : "followup",
        cap: mode === "collect" ? 2 : 1,
        debounceMs: 0,
      });
      const released = createDeferred();
      const canceled = new AbortController();
      const firstAdopted = vi.fn(async () => {});
      const firstSettled = vi.fn();
      const secondSettled = vi.fn();
      const secondAdopted = vi.fn(async () => {
        canceled.abort();
        throw new IngressAdoptionLostError("guillotined");
      });
      for (const [prompt, onAdopted, onSettled, abortSignal] of [
        ["first source", firstAdopted, firstSettled, undefined],
        ["second source", secondAdopted, secondSettled, canceled.signal],
      ] as const) {
        q.add({
          ...createRun({ prompt, originatingChannel: "webchat" }),
          abortSignal,
          turnAdoptionLifecycle: { admission: "cancel-only", onAdopted, onSettled },
        });
      }
      if (mode === "overflow") {
        q.add(createRun({ prompt: "live item", originatingChannel: "webchat" }));
      }
      const terminalErrors: unknown[] = [];
      q.start(async (run) => {
        if (q.calls.length === 0) {
          const observeRelease = captureGatewayRootWorkReleaseObserver();
          expect(observeRelease).toBeDefined();
          observeRelease?.(() => released.resolve());
        }
        if (isFollowupRunAborted(run)) {
          return;
        }
        q.calls.push(run);
        try {
          await admitFollowupRunLifecycle(run);
        } catch (error) {
          if (!isIngressAdoptionLostError(error)) {
            throw error;
          }
          // Execution already owns the input and returns a terminal failure reply.
          terminalErrors.push(error);
        }
        completeFollowupRunLifecycle(run);
      });
      try {
        await withinTest(released.promise, signal);
        expect(q.calls).toHaveLength(mode === "collect" ? 1 : 2);
        expect(q.calls[0]?.prompt).toContain("second source");
        if (mode === "overflow") {
          expect(q.calls[1]?.prompt).toBe("live item");
          await withinTest(q.calls[1]!.controllerInput!.claim!.settlement.promise, signal);
        }
        expect(terminalErrors).toEqual([
          expect.objectContaining({ name: "IngressAdoptionLostError", code: "guillotined" }),
        ]);
        expect(firstAdopted).toHaveBeenCalledOnce();
        expect(secondAdopted).toHaveBeenCalledOnce();
        expect(firstSettled).toHaveBeenCalledOnce();
        expect(secondSettled).toHaveBeenCalledOnce();
        expect(getExistingFollowupQueue(q.key)).toBeUndefined();
      } finally {
        clearFollowupQueue(q.key);
      }
    },
  );

  it("retries survivors when an earlier source owns the sole pre-admission cancel signal", async () => {
    const q = createQueueCase({ mode: "collect", debounceMs: 0 }, 1);
    const canceled = new AbortController();
    const canceledComplete = vi.fn();
    const survivorComplete = vi.fn();
    const enqueueSource = (prompt: string, onComplete: () => void, abortSignal?: AbortSignal) => {
      const source: FollowupRun = {
        ...createRun({ prompt }),
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
      };
      if (abortSignal) {
        source.abortSignal = abortSignal;
      }
      q.add(source);
    };
    enqueueSource("canceled", canceledComplete, canceled.signal);
    enqueueSource("survivor", survivorComplete);
    q.start(async (run) => {
      q.calls.push(run);
      if (q.calls.length === 1) {
        canceled.abort();
        expect(run.abortSignal?.aborted).toBe(true);
        rejectQueuePreparation(run, new Error("source cancelled during preparation"));
      }
      q.done.resolve();
    });
    await q.done.promise;
    expect(q.calls).toHaveLength(2);
    expect(q.calls[0]?.prompt).toContain("canceled");
    expect(q.calls[0]?.prompt).toContain("survivor");
    expect(q.calls[1]?.prompt).toContain("survivor");
    expect(q.calls[1]?.prompt).not.toContain("canceled");
    await vi.waitFor(() => expect(survivorComplete).toHaveBeenCalledTimes(1));
    expect(canceledComplete).toHaveBeenCalledTimes(1);
  });

  it("removes a pre-aborted queue-case elision without leaking it into the summary", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 }, 1);
    const elidedComplete = vi.fn();
    const elided = new AbortController();
    const abortedCleanup = vi.fn();
    const runFollowup = async (run: FollowupRun) => {
      if (run.abortSignal?.aborted) {
        abortedCleanup(run.prompt);
        return;
      }
      q.calls.push(run);
      if (q.calls.length === 2) {
        q.done.resolve();
      }
    };
    for (const source of [
      {
        ...createRun({ prompt: "elided and cancelled" }),
        abortSignal: elided.signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: elidedComplete },
      },
      createRun({ prompt: "retained summary" }),
      createRun({ prompt: "live item" }),
    ]) {
      enqueueFollowupRun(q.key, source, q.settings, "none", runFollowup, false);
    }
    elided.abort();
    await q.drain(runFollowup);
    expect(q.calls.map((call) => call.prompt).join("\n")).not.toContain("elided and cancelled");
    expect(q.calls[0]?.prompt).toContain("retained summary");
    expect(q.calls[1]?.prompt).toBe("live item");
    expect(elidedComplete).toHaveBeenCalledTimes(1);
    expect(abortedCleanup).toHaveBeenCalledExactlyOnceWith("elided and cancelled");
  });

  it("does not replay queue-case elisions after an admitted summary failure", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 }, 1);
    const elidedComplete = vi.fn();
    const retainedComplete = vi.fn();
    q.add({
      ...createRun({ prompt: "elided source" }),
      turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: elidedComplete },
    });
    q.add({
      ...createRun({ prompt: "retained source" }),
      turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: retainedComplete },
    });
    q.add(createRun({ prompt: "live item" }));
    q.start(async (run) => {
      q.calls.push(run);
      if (q.calls.length === 1) {
        expect(run.prompt).toContain("Dropped 2 messages");
        expect(run.prompt).toContain("retained source");
        await run.turnAdoptionLifecycle?.onAdopted?.();
        expect(getExistingFollowupQueue(q.key)?.summaryElisions).toEqual([]);
        expect(getExistingFollowupQueue(q.key)?.droppedCount).toBe(0);
        throw new Error("admitted summary failure");
      }
      q.done.resolve();
    });
    await q.done.promise;
    expect(q.calls).toHaveLength(2);
    expect(q.calls[1]?.prompt).toBe("live item");
    expect(elidedComplete).toHaveBeenCalledOnce();
    expect(retainedComplete).toHaveBeenCalledOnce();
  });

  it("keeps collected transcript ownership across an admitted session rotation", async () => {
    const q = createQueueCase({ mode: "collect", debounceMs: 0 }, 1);
    const firstComplete = vi.fn();
    const settled = createDeferred();
    const secondComplete = vi.fn(() => settled.resolve());
    const firstCorrelationEnd = vi.fn();
    const secondCorrelationEnd = vi.fn();
    const firstCorrelation = { begin: vi.fn(() => firstCorrelationEnd) };
    const secondCorrelation = { begin: vi.fn(() => secondCorrelationEnd) };
    const createRecorder = (text: string, mediaPath: string) =>
      createUserTurnTranscriptRecorder({
        input: {
          text,
          media: [{ path: mediaPath, contentType: "image/png" }],
          mentions: [
            { profileId: "ada", start: text.indexOf("@Ada"), end: text.indexOf("@Ada") + 4 },
          ],
        },
        target: createTestUserTurnTranscriptTarget(),
        updateMode: "none",
      });
    const firstRecorder = createRecorder("first transcript @Ada", "/tmp/first.png");
    const secondRecorder = createRecorder("second transcript 🦞 @Ada", "/tmp/second.png");
    const receipts: ReplyOperationRunState[] = [{}, {}];
    for (const [prompt, recorder, onComplete, deliveryCorrelation] of [
      ["first", firstRecorder, firstComplete, firstCorrelation],
      ["second", secondRecorder, secondComplete, secondCorrelation],
    ] as const) {
      q.add({
        ...createRun({ prompt }),
        transcriptPrompt: `${prompt} transcript`,
        userTurnTranscriptRecorder: recorder,
        currentInboundContext: { text: "shared gateway context", promptJoiner: " " },
        deliveryCorrelations: [deliveryCorrelation],
        replyOperationRunStates: [recorder === firstRecorder ? receipts[0]! : receipts[1]!],
        abortSignal: new AbortController().signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
      });
    }
    let queuedSourcesAfterAdmission: number | undefined;
    await q.drain(async (run) => {
      await admitFollowupRunLifecycle(run);
      queuedSourcesAfterAdmission = getExistingFollowupQueue(q.key)?.items.length;
      refreshQueuedFollowupSession({
        key: q.key,
        previousSessionId: run.run.sessionId,
        nextSessionId: "after-preflight-compaction",
      });
      expect(run.deliveryCorrelations).toHaveLength(2);
      run.deliveryCorrelations?.[0]?.begin()?.({ visibleReplySent: true, failed: false });
      expect(firstCorrelation.begin).toHaveBeenCalledOnce();
      expect(secondCorrelation.begin).not.toHaveBeenCalled();
      run.deliveryCorrelations?.[1]?.begin()?.({ visibleReplySent: true, failed: false });
      await q.runFollowup(run);
    });
    expect(q.calls).toHaveLength(1);
    expect(q.calls[0]?.replyOperationRunStates).toEqual(receipts);
    expect(q.calls[0]?.replyOperationRunStates?.[0]).toBe(receipts[0]);
    expect(q.calls[0]?.replyOperationRunStates?.[1]).toBe(receipts[1]);
    expect(queuedSourcesAfterAdmission).toBe(0);
    expect(q.calls[0]?.prompt).toContain("first");
    expect(q.calls[0]?.prompt).toContain("second");
    expect(q.calls[0]?.transcriptPrompt).toContain("first transcript");
    expect(q.calls[0]?.transcriptPrompt).toContain("second transcript");
    expect(q.calls[0]?.currentInboundContext?.text).toContain(
      "Queued #1 context:\nshared gateway context",
    );
    expect(q.calls[0]?.currentInboundContext?.text).toContain(
      "Queued #2 context:\nshared gateway context",
    );
    expect(q.calls[0]?.currentInboundContext?.promptJoiner).toBe("\n\n");
    expect(firstCorrelation.begin).toHaveBeenCalledOnce();
    expect(secondCorrelation.begin).toHaveBeenCalledOnce();
    expect(firstCorrelationEnd).toHaveBeenCalledExactlyOnceWith({
      visibleReplySent: true,
      failed: false,
    });
    expect(secondCorrelationEnd).toHaveBeenCalledExactlyOnceWith({
      visibleReplySent: true,
      failed: false,
    });
    expect(q.calls[0]?.userTurnTranscriptRecorder).not.toBe(firstRecorder);
    expect(q.calls[0]?.userTurnTranscriptRecorder).not.toBe(secondRecorder);
    const message = await q.calls[0]?.userTurnTranscriptRecorder?.resolveMessage();
    expect(message?.idempotencyKey).toMatch(/^followup-collect:after-preflight-compaction:/);
    expect(message?.content).toContain("first transcript");
    expect(message?.content).toContain("second transcript");
    const mentions = message?.["__openclaw"]?.humanMentions;
    expect(mentions).toHaveLength(2);
    expect(
      mentions?.map((mention) =>
        typeof message?.content === "string"
          ? message.content.slice(mention.start, mention.end)
          : undefined,
      ),
    ).toEqual(["@Ada", "@Ada"]);
    expect(mentions?.[1]?.start).toBeGreaterThan(mentions?.[0]?.end ?? 0);
    expect(
      (message as unknown as { __openclaw?: { media?: Array<{ path?: string }> } } | undefined)?.[
        "__openclaw"
      ]?.media?.map((fact) => fact.path),
    ).toEqual(["/tmp/first.png", "/tmp/second.png"]);
    await settled.promise;
    expect(firstComplete).toHaveBeenCalledTimes(1);
    expect(secondComplete).toHaveBeenCalledTimes(1);
  });

  it("admits one lifecycle-owned overflow source before delivery", async () => {
    const key = `test-overflow-summary-single-admission-${Date.now()}`;
    const events: string[] = [];
    const done = createDeferred();
    const sourceComplete = vi.fn(() => {
      events.push("source-complete");
    });
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "dropped lifecycle source" }),
        turnAdoptionLifecycle: {
          onAdopted: async () => {
            events.push("source-admitted");
          },
          onSettled: sourceComplete,
          admission: "exclusive",
          onAbandoned: () => {},
        },
      },
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "live followup" }), settings);

    scheduleFollowupDrain(key, async (run) => {
      if (run.prompt.includes("[Queue overflow]")) {
        events.push("summary-started");
        expect(run.turnAdoptionLifecycle?.onAdopted).toEqual(expect.any(Function));
        await run.turnAdoptionLifecycle?.onAdopted?.();
        events.push("model");
        await run.turnAdoptionLifecycle?.onSettled?.();
        return;
      }
      events.push("live-followup");
      done.resolve();
    });
    await done.promise;

    expect(sourceComplete).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "summary-started",
      "source-admitted",
      "model",
      "source-complete",
      "live-followup",
    ]);
  });

  it("keeps one onComplete-only overflow source retryable after delivery fails", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 }, 1);
    const firstAttempt = createDeferred();
    const releaseRetry = createDeferred();
    const onComplete = vi.fn();
    let attempts = 0;
    const runFollowup = async (run: FollowupRun) => {
      q.calls.push(run);
      expect(run.turnAdoptionLifecycle?.onAdopted).toEqual(expect.any(Function));

      attempts += 1;
      if (attempts === 1) {
        firstAttempt.resolve();
        rejectQueuePreparation(run, new Error("transient preparation failure"));
      }
      await releaseRetry.promise;
      q.done.resolve();
    };
    q.add({
      ...createRun({ prompt: "dropped ambient" }),
      currentInboundEventKind: "room_event",
      currentInboundContext: { text: "dropped context" },
      turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
    });
    q.add(createRun({ prompt: "live followup" }));
    q.start(runFollowup);
    await firstAttempt.promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(getExistingFollowupQueue(q.key)?.summarySources).toHaveLength(1);
    expect(getExistingFollowupQueue(q.key)?.summarySources[0]?.currentInboundEventKind).toBe(
      "room_event",
    );
    expect(getExistingFollowupQueue(q.key)?.summarySources[0]?.turnAdoptionLifecycle).toBeDefined();
    expect(q.calls[0]?.currentInboundContext).toBeUndefined();

    releaseRetry.resolve();
    await q.done.promise;
    expect(q.calls).toHaveLength(2);
    expect(q.calls[1]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(q.calls[1]?.prompt).toContain("- dropped ambient");
    expect(q.calls[1]?.currentInboundEventKind).toBe("room_event");
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("runs distinct collected admission lifecycles independently when one retries", async () => {
    const key = `test-collect-admission-isolation-${Date.now()}`;
    const events: string[] = [];
    const done = createDeferred();
    const secondAdmissionError = new Error("second admission failed");
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    const first = createRun({ prompt: "first" });
    first.turnAdoptionLifecycle = {
      onAdopted: async () => {
        events.push("first-admitted");
      },
      admission: "exclusive",
      onAbandoned: () => {},
    };
    const second = createRun({ prompt: "second" });
    second.turnAdoptionLifecycle = {
      onAdopted: vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(async () => {
          events.push("second-rejected");
          throw secondAdmissionError;
        })
        .mockImplementationOnce(async () => {
          events.push("second-admitted");
        }),
      admission: "exclusive",
      onAbandoned: () => {},
    };

    enqueueFollowupRun(key, first, settings);
    enqueueFollowupRun(key, second, settings);

    await drainSettledQueue(key, async (run) => {
      const prompt = run.prompt.includes("first") ? "first" : "second";
      events.push(`run:${prompt}`);
      try {
        await admitFollowupRunLifecycle(run);
      } catch (error) {
        events.push(`error:${prompt}`);
        rejectQueuePreparation(run, error instanceof Error ? error : new Error(String(error)));
      }
      events.push(`model:${prompt}`);
      if (prompt === "second") {
        done.resolve();
      }
    });

    expect(events).toEqual([
      "run:first",
      "first-admitted",
      "model:first",
      "run:second",
      "second-rejected",
      "error:second",
      "run:second",
      "second-admitted",
      "model:second",
    ]);
    expect(second.turnAdoptionLifecycle.onAdopted).toHaveBeenCalledTimes(2);
  });

  it("pairs differing inbound runtime contexts inside one collected turn", async () => {
    const key = `test-collect-runtime-context-split-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder();
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    for (const [prompt, contextText] of [
      ["first", "context one"],
      ["second", "context two"],
    ] as const) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({ prompt }),
          currentInboundContext: { text: contextText },
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).toContain("second");
    expect(calls[0]?.currentInboundContext?.text).toContain("Queued #1 context:\ncontext one");
    expect(calls[0]?.currentInboundContext?.text).toContain("Queued #2 context:\ncontext two");
  });

  it("does not let one source cancel an admitted collected run", async () => {
    const key = `test-collect-transcript-cancel-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const canceled = new AbortController();
    const survivor = new AbortController();
    const sourceCompletions = [vi.fn(), vi.fn()];
    const sourceCancellationRetirements = [vi.fn(), vi.fn()];
    let firstResolvedContent = "";
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const createRecorder = (text: string) =>
      createUserTurnTranscriptRecorder({
        input: { text },
        target: createTestUserTurnTranscriptTarget(),
        updateMode: "none",
      });

    for (const [index, [prompt, abortSignal]] of (
      [
        ["canceled", canceled.signal],
        ["survivor", survivor.signal],
      ] as const
    ).entries()) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({ prompt }),
          transcriptPrompt: `${prompt} transcript`,
          userTurnTranscriptRecorder: createRecorder(`${prompt} transcript`),
          abortSignal,
          turnAdoptionLifecycle: {
            onAdopted: async () => {},
            onCancellationRetired: sourceCancellationRetirements[index],
            onSettled: sourceCompletions[index],
          },
        },
        settings,
      );
    }

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        expect(run.abortSignal).toBeDefined();
        expect(run.abortSignal).not.toBe(survivor.signal);
        await run.turnAdoptionLifecycle?.onAdopted?.();
        expect(sourceCancellationRetirements[0]).toHaveBeenCalledTimes(1);
        expect(sourceCancellationRetirements[1]).not.toHaveBeenCalled();
        expect(sourceCompletions[0]).not.toHaveBeenCalled();
        expect(sourceCompletions[1]).not.toHaveBeenCalled();
        canceled.abort();
        expect(run.abortSignal?.aborted).toBe(false);
        const resolved = await run.userTurnTranscriptRecorder?.resolveMessage();
        firstResolvedContent = typeof resolved?.content === "string" ? resolved.content : "";
        done.resolve();
      }
    });
    await done.promise;

    expect(calls).toHaveLength(1);
    expect(firstResolvedContent).toContain("survivor transcript");
    expect(firstResolvedContent).toContain("canceled transcript");
    await vi.waitFor(() => expect(sourceCompletions[1]).toHaveBeenCalledTimes(1));
    expect(sourceCompletions[0]).toHaveBeenCalledTimes(1);
    expect(sourceCompletions[1]).toHaveBeenCalledTimes(1);
    expect(getExistingFollowupQueue(key)?.items ?? []).toHaveLength(0);
  });

  it("keeps queue cancellation connected after collect admission", async () => {
    const key = `test-collect-queue-cancel-${Date.now()}`;
    const done = createDeferred();
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    enqueueFollowupRun(key, createRun({ prompt: "first" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "second" }), settings);

    scheduleFollowupDrain(key, async (run) => {
      expect(run.abortSignal).toBeUndefined();
      expect(run.queueAbortSignal?.aborted).toBe(false);
      await run.turnAdoptionLifecycle?.onAdopted?.();
      clearFollowupQueue(key);
      expect(run.queueAbortSignal?.aborted).toBe(true);
      done.resolve();
    });
    await done.promise;
  });

  it.each(["first", "last"] as const)(
    "retries survivors when the %s source owns the sole pre-admission cancel signal",
    async (canceledPosition) => {
      const key = `test-collect-pre-admission-cancel-${canceledPosition}-${Date.now()}`;
      const canceled = new AbortController();
      const canceledComplete = vi.fn();
      const survivorComplete = vi.fn();
      const { calls, done } = createDrainRecorder();
      const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

      const enqueueSource = (prompt: string, onComplete: () => void, abortSignal?: AbortSignal) => {
        const source: FollowupRun = {
          ...createRun({ prompt }),
          turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
        };
        if (abortSignal) {
          source.abortSignal = abortSignal;
        }
        enqueueFollowupRun(key, source, settings);
      };
      if (canceledPosition === "first") {
        enqueueSource("canceled", canceledComplete, canceled.signal);
        enqueueSource("survivor", survivorComplete);
      } else {
        enqueueSource("survivor", survivorComplete);
        enqueueSource("canceled", canceledComplete, canceled.signal);
      }

      await drainSettledQueue(key, async (run) => {
        calls.push(run);
        if (calls.length === 1) {
          canceled.abort();
          expect(run.abortSignal?.aborted).toBe(true);
          rejectQueuePreparation(run, new Error("source cancelled during preparation"));
        }
        done.resolve();
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]?.prompt).toContain("canceled");
      expect(calls[0]?.prompt).toContain("survivor");
      expect(calls[1]?.prompt).toContain("survivor");
      expect(calls[1]?.prompt).not.toContain("canceled");
      await vi.waitFor(() => expect(survivorComplete).toHaveBeenCalledTimes(1));
      expect(canceledComplete).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps summarized work when a different cancelable live item is aborted", async () => {
    const key = `test-summary-owner-isolation-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const summarizedComplete = vi.fn();
    const abortedComplete = vi.fn();
    const aborted = new AbortController();
    const runFollowup = async (run: FollowupRun) => {
      if (run.abortSignal?.aborted) {
        return;
      }
      calls.push(run);
      done.resolve();
    };
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "owner A summary" }),
        abortSignal: new AbortController().signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: summarizedComplete },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "owner B live" }),
        abortSignal: aborted.signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: abortedComplete },
      },
      settings,
    );
    aborted.abort();

    await drainSettledQueue(key, runFollowup);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("owner A summary");
    expect(calls[0]?.prompt).not.toContain("owner B live");
    await vi.waitFor(() => expect(summarizedComplete).toHaveBeenCalledTimes(1));
    expect(summarizedComplete).toHaveBeenCalledTimes(1);
    expect(abortedComplete).toHaveBeenCalledTimes(1);
  });

  it("removes an aborted elided source without leaking it into the summary", async () => {
    const key = `test-elided-summary-cancel-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const elidedComplete = vi.fn();
    const elided = new AbortController();
    const runFollowup = async (run: FollowupRun) => {
      if (run.abortSignal?.aborted) {
        return;
      }
      calls.push(run);
      if (calls.length === 2) {
        done.resolve();
      }
    };
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "elided and cancelled" }),
        abortSignal: elided.signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: elidedComplete },
      },
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "retained summary" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "live item" }), settings);
    elided.abort();

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.prompt).join("\n")).not.toContain("elided and cancelled");
    expect(calls[0]?.prompt).toContain("retained summary");
    expect(calls[1]?.prompt).toBe("live item");
    expect(elidedComplete).toHaveBeenCalledTimes(1);
  });

  it("does not replay elided sources after an admitted summary failure", async () => {
    const key = `test-elided-summary-admitted-failure-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const elidedComplete = vi.fn();
    const retainedComplete = vi.fn();
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "elided source" }),
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: elidedComplete },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "retained source" }),
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: retainedComplete },
      },
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "live item" }), settings);

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        expect(run.prompt).toContain("Dropped 2 messages");
        expect(run.prompt).toContain("retained source");
        await run.turnAdoptionLifecycle?.onAdopted?.();
        throw new Error("admitted summary failure");
      }
      done.resolve();
    });
    await done.promise;

    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toBe("live item");
    expect(elidedComplete).toHaveBeenCalledOnce();
    expect(retainedComplete).toHaveBeenCalledOnce();
  });

  it("runs distinct overflow admission lifecycles independently when one retries", async () => {
    const key = `test-overflow-admission-isolation-${Date.now()}`;
    const events: string[] = [];
    const done = createDeferred();
    const secondAdmissionError = new Error("second overflow admission failed");
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    const first = createRun({ prompt: "first dropped" });
    first.turnAdoptionLifecycle = {
      onAdopted: async () => {
        events.push("first-admitted");
      },
      admission: "exclusive",
      onAbandoned: () => {},
    };
    const second = createRun({ prompt: "second dropped" });
    second.turnAdoptionLifecycle = {
      onAdopted: vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(async () => {
          events.push("second-rejected");
          throw secondAdmissionError;
        })
        .mockImplementationOnce(async () => {
          events.push("second-admitted");
        }),
      admission: "exclusive",
      onAbandoned: () => {},
    };

    enqueueFollowupRun(key, first, settings);
    enqueueFollowupRun(key, second, settings);
    enqueueFollowupRun(key, createRun({ prompt: "live followup" }), settings);

    scheduleFollowupDrain(key, async (run) => {
      if (run.prompt.includes("[Queue overflow]")) {
        events.push("summary-run");
        try {
          await admitFollowupRunLifecycle(run);
        } catch (error) {
          events.push("summary-error");
          rejectQueuePreparation(run, error instanceof Error ? error : new Error(String(error)));
        }
        events.push("summary-model");
        return;
      }
      events.push("live-followup");
      done.resolve();
    });

    await done.promise;

    expect(events).toEqual([
      "summary-run",
      "first-admitted",
      "summary-model",
      "summary-run",
      "second-rejected",
      "summary-error",
      "summary-run",
      "second-admitted",
      "summary-model",
      "live-followup",
    ]);
    expect(second.turnAdoptionLifecycle.onAdopted).toHaveBeenCalledTimes(2);
  });
});
describe("followup authorization delivery context", () => {
  it("changes when the approval reviewer device changes", () => {
    const run = createRun({ prompt: "one" });
    const keyFor = (approvalReviewerDeviceId: string) =>
      resolveFollowupDeliveryStorageKey({
        ...run,
        run: { ...run.run, approvalReviewerDeviceId },
      });
    expect(keyFor("device-a")).not.toBe(keyFor("device-b"));
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
