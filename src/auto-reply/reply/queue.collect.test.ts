import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { projectRuntimeContextFragments } from "../../agents/internal-runtime-context.js";
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
  createOffloadedImageQueueRun,
  rejectQueuePreparation,
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

function enqueuePriorityRun(key: string, settings: QueueSettings) {
  return enqueueFollowupRun(
    key,
    createRun({ prompt: "priority retry" }),
    settings,
    "none",
    undefined,
    false,
    { position: "front" },
  );
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
    const q = createQueueCase();
    for (const cronCreatorAuthorityUnavailable of ["queued-local-operator", undefined] as const) {
      q.enqueue({
        prompt: "queued turn",
        turnAdoptionLifecycle: {
          admission: "cancel-only",
          ownerKey: "gateway:local",
          cronCreatorAuthorityUnavailable,
          onAdopted: async () => {},
        },
      });
    }
    await q.drain();
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
        await vi.advanceTimersByTimeAsync(515);
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
    const q = createQueueCase({ mode: "followup", debounceMs: 10_000, cap: 50 });
    const onEnqueued = vi.fn(() => false);
    const run = createRun({ prompt: "duplicate owner" });
    run.turnAdoptionLifecycle = { onAdopted: async () => {}, onDeferred: onEnqueued };
    const enqueued = q.add(run);
    expect(enqueued).toBe(false);
    expect(onEnqueued).toHaveBeenCalledTimes(1);
    expect(getExistingFollowupQueue(q.key)?.items ?? []).toEqual([]);
    clearFollowupQueue(q.key);
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
    const q = createQueueCase();
    const { calls } = q;

    const receipts: ReplyOperationRunState[] = [{}, {}];
    for (const [index, receipt] of receipts.entries()) {
      const run = createRun({
        prompt: String(index + 1),
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingChatType: "channel",
      });
      run.replyOperationRunStates = [receipt];
      q.add(run);
    }

    await q.drain();
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.originatingChannel).toBe("slack");
    expect(calls[0]?.originatingTo).toBe("channel:A");
    expect(calls[0]?.originatingChatType).toBe("channel");
    expect(calls[0]?.replyOperationRunStates).toEqual(receipts);
    expect(calls[0]?.replyOperationRunStates?.[0]).toBe(receipts[0]);
    expect(calls[0]?.replyOperationRunStates?.[1]).toBe(receipts[1]);
  });

  it.each([
    ["off", "slack", true, true],
    ["all", "slack", true, false],
    ["first", " Slack ", false, false],
    ["batched", "SLACK", false, false],
  ] as const)(
    "routes standalone Slack collect batches in %s reply mode",
    async (replyToMode, originatingChannel, anchors, collect) => {
      const q = createQueueCase({}, collect ? 1 : 2);
      const { calls } = q;
      for (const [prompt, messageId] of [
        ["one", "101.001"],
        ["two", "101.002"],
      ] as const) {
        q.enqueue({
          prompt,
          messageId,
          originatingChannel,
          originatingTo: "channel:A",
          originatingReplyToMode: replyToMode,
          originatingReplyToId: anchors ? messageId : undefined,
          originatingChatType: "channel",
        });
      }
      await q.drain();
      if (collect) {
        expect(calls).toHaveLength(1);
        expect(calls[0]?.prompt).toContain("Queued #1\none");
        expect(calls[0]?.prompt).toContain("Queued #2\ntwo");
      } else {
        expect(calls.map((call) => call.prompt)).toEqual(["one", "two"]);
        expect(calls.map((call) => call.messageId)).toEqual(["101.001", "101.002"]);
      }
    },
  );

  it("keeps history-policy peers separate when delivery targets coincide", async () => {
    const q = createQueueCase({}, 2);
    const { calls } = q;
    for (const peerId of ["peer", "direct:peer"]) {
      q.slack(peerId, { conversationRoutePeerId: peerId });
    }
    await q.drain();
    expect(calls.map((call) => call.run.conversationRoutePeerId)).toEqual(["peer", "direct:peer"]);
    expect(calls.map((call) => call.prompt)).toEqual(["peer", "direct:peer"]);
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
    const q = createQueueCase({ cap: 2 });

    const accepted = ["A", "B", "A", "B", "A", "B", "survivor"].map((target, index) =>
      q.enqueue({
        prompt: `message ${index}`,
        originatingChannel: "slack",
        originatingTo: `channel:${target}`,
        originatingChatType: "channel",
      }),
    );

    const queue = getExistingFollowupQueue(q.key);
    expect(accepted).toEqual([true, true, true, true, true, true, true]);
    expect(
      queue?.summaryElisions.map((entry) => entry.entries.at(-1)?.source.originatingTo),
    ).toEqual(["channel:B", "channel:A"]);
    expect(queue?.items.map((item) => item.originatingTo)).toEqual([
      "channel:B",
      "channel:survivor",
    ]);
    clearFollowupQueue(q.key);
  });

  it("bounds retained overflow cancellation identities by the item cap", async () => {
    const q = createQueueCase({ cap: 2 });
    const completions = Array.from({ length: 8 }, () => vi.fn());

    for (const [index, onComplete] of completions.entries()) {
      q.add({
        ...createRun({
          prompt: `message ${index}`,
          originatingChannel: "slack",
          originatingTo: "channel:A",
          originatingChatType: "channel",
        }),
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
      });
    }

    const queue = getExistingFollowupQueue(q.key);
    expect(queue?.summaryElisions.flatMap((entry) => entry.entries)).toHaveLength(2);
    expect(
      queue?.summaryElisions.flatMap((entry) => entry.entries.map(({ source }) => source.prompt)),
    ).toEqual(["message 2", "message 3"]);
    await Promise.all(
      queue!.entries
        .filter((input) => input.retirementRequested)
        .map((input) => input.settlement.promise),
    );
    expect(completions.map((onComplete) => onComplete.mock.calls.length)).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0,
    ]);
    clearFollowupQueue(q.key);
  });

  it.each(["old", "new"] as const)(
    "settles a drop:%s source after its terminal receipt",
    async (dropPolicy) => {
      const q = createQueueCase({ mode: "followup", cap: 1, dropPolicy });
      const dropCommit = createDeferred();
      const onDropped = vi.fn(() => dropCommit.promise);
      const onAbandoned = vi.fn();
      const onDeferred = vi.fn();
      const onDisposition = vi.fn();
      const onSettled = vi.fn();
      const dropped = createRun({
        prompt: "dropped",
        onQueueDisposition: onDisposition,
        turnAdoptionLifecycle: {
          admission: "exclusive",
          onAdopted: async () => {},
          onDeferred,
          onDropped,
          onAbandoned,
          onSettled,
        },
      });
      const survivor = createRun({ prompt: "survivor" });
      try {
        expect(q.add(dropPolicy === "old" ? dropped : survivor)).toBe(true);
        expect(q.add(dropPolicy === "old" ? survivor : dropped)).toBe(dropPolicy === "old");
        expect(onDeferred).toHaveBeenCalledTimes(dropPolicy === "old" ? 1 : 0);
        expect(onDisposition).toHaveBeenCalledExactlyOnceWith(`queue-cap-${dropPolicy}`);
        expect(onDropped).toHaveBeenCalledExactlyOnceWith(`queue-cap-${dropPolicy}`);
        expect(onAbandoned).not.toHaveBeenCalled();
        expect(getExistingFollowupQueue(q.key)?.items).toEqual([survivor]);
        const settled = vi.fn();
        void dropped.controllerInput!.settlement.promise.then(settled);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        expect(onSettled).not.toHaveBeenCalled();
        dropCommit.resolve();
        await dropped.controllerInput!.settlement.promise;
        expect(settled).toHaveBeenCalledOnce();
        expect(onSettled).toHaveBeenCalledOnce();
        await q.drain();
        expect(q.calls.map((run) => run.prompt)).toEqual(["survivor"]);
      } finally {
        dropCommit.resolve();
        clearFollowupQueue(q.key);
      }
    },
  );

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
    const q = createQueueCase({ cap: 1 });
    const prompts: string[] = [];
    const onComplete = vi.fn();
    q.enqueue({
      prompt: "private source",
      originatingChannel: "slack",
      originatingTo: "same-target",
      originatingChatType: "direct",
      turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
    });
    q.enqueue({
      prompt: "public survivor",
      originatingChannel: "slack",
      originatingTo: "same-target",
      originatingChatType: "channel",
    });
    await drainSettledQueue(q.key, async (run) => {
      prompts.push(run.prompt);
      if (prompts.length === 1) {
        rejectQueuePreparation(run, new Error("transient summary preparation failure"));
      }
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("- private source");
    expect(prompts[1]).toContain("- private source");
    expect(prompts[2]).toContain("public survivor");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("keeps overflow summary text paired with its source route", async () => {
    const q = createQueueCase({ cap: 1 });
    const { calls, done } = q;
    q.enqueueMany(
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

    q.start(async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        q.enqueue({
          prompt: "surviving C",
          originatingChannel: "slack",
          originatingTo: "same-target",
          originatingChatType: "channel",
        });
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

  it.each([
    {
      prompt: "different route",
      originatingChannel: "slack",
      originatingTo: "channel:A",
      originatingChatType: "channel",
    },
    { prompt: "unresolved origin" },
    { prompt: "route-less direct", originatingChatType: "direct" },
  ] as const)("isolates $prompt before collecting routed peers", async (first) => {
    const q = createQueueCase({}, 2);
    q.enqueue(first);
    for (const prompt of ["peer one", "peer two"]) {
      q.slack(prompt, {}, { originatingTo: "channel:B", originatingChatType: "channel" });
    }
    await q.drain();

    expect(q.calls).toHaveLength(2);
    expect(q.calls[0]).toMatchObject(first);
    expect(q.calls[0]?.originatingChannel).toBe(
      "originatingChannel" in first ? first.originatingChannel : undefined,
    );
    expect(q.calls[1]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(q.calls[1]?.prompt).toContain("Queued #1\npeer one");
    expect(q.calls[1]?.prompt).toContain("Queued #2\npeer two");
    expect(q.calls[1]?.prompt).not.toContain(first.prompt);
    expect(q.calls[1]).toMatchObject({
      originatingChannel: "slack",
      originatingTo: "channel:B",
      originatingChatType: "channel",
    });
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
    const q = createQueueCase({ mode: "followup" }, 3);
    q.enqueueMany({ prompt: "queued later one" }, { prompt: "queued later two" });
    enqueuePriorityRun(q.key, q.settings);
    await q.drain();
    expect(q.calls.map((item) => item.prompt)).toEqual([
      "priority retry",
      "queued later one",
      "queued later two",
    ]);
    expect(q.calls[0]?.protectFromQueueOverflow).toBe(true);
  });

  it("preserves prepended priority followups during old-item overflow eviction", () => {
    const q = createQueueCase({ mode: "followup", cap: 2, dropPolicy: "old" });
    q.enqueueMany({ prompt: "queued later one" }, { prompt: "queued later two" });
    enqueuePriorityRun(q.key, q.settings);
    q.enqueue({ prompt: "queued later three" });

    expect(getExistingFollowupQueue(q.key)?.items.map((item) => item.prompt)).toEqual([
      "priority retry",
      "queued later three",
    ]);
  });

  it.each(["old", "new", "summarize"] as const)(
    "keeps protected drop:%s overflow retryable without advancing debounce",
    async (dropPolicy) => {
      const q = createQueueCase({ mode: "followup", debounceMs: 5_000, cap: 1, dropPolicy });
      const onAbandoned = vi.fn();
      const onDropped = vi.fn();
      const rejected = createRun({
        prompt: "normal after priority",
        turnAdoptionLifecycle: { onAdopted: async () => {}, onAbandoned, onDropped },
      });
      expect(enqueuePriorityRun(q.key, q.settings)).toBe(true);
      const stampedAt = getExistingFollowupQueue(q.key)!.lastEnqueuedAt;
      expect(q.add(rejected)).toBe(false);
      await rejected.controllerInput!.settlement.promise;
      expect(onAbandoned).toHaveBeenCalledOnce();
      expect(onDropped).not.toHaveBeenCalled();
      expect(getExistingFollowupQueue(q.key)?.lastEnqueuedAt).toBe(stampedAt);
      expect(getExistingFollowupQueue(q.key)?.items.map((item) => item.prompt)).toEqual([
        "priority retry",
      ]);
      expect(getExistingFollowupQueue(q.key)?.summaryEntries).toHaveLength(0);
      clearFollowupQueue(q.key);
    },
  );

  it("leaves the queue untouched when protected overflow cannot drop enough items", () => {
    const q = createQueueCase({ mode: "followup", cap: 3 });
    enqueuePriorityRun(q.key, q.settings);
    q.enqueueMany({ prompt: "normal one" }, { prompt: "normal two" });
    const accepted = q.add(createRun({ prompt: "normal after shrink" }), {
      ...q.settings,
      cap: 1,
    });
    expect(accepted).toBe(false);
    expect(getExistingFollowupQueue(q.key)?.items.map((item) => item.prompt)).toEqual([
      "priority retry",
      "normal one",
      "normal two",
    ]);
    expect(getExistingFollowupQueue(q.key)?.summaryEntries).toHaveLength(0);
  });

  it("drains protected priority followups before overflow summaries", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 }, 2);
    q.add(createRun({ prompt: "overflowed normal" }));
    enqueuePriorityRun(q.key, q.settings);
    await q.drain();
    expect(q.calls).toHaveLength(2);
    expect(q.calls[0]?.prompt).toBe("priority retry");
    expect(q.calls[1]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(q.calls[1]?.prompt).toContain("- overflowed normal");
  });

  it("preserves prepared media through elided overflow and collected execution", async () => {
    const q = createQueueCase({ cap: 1 });
    for (const [index, prompt] of ["first", "second", "survivor"].entries()) {
      const source = createOffloadedImageQueueRun(prompt, index);
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
      const preparedRun = createOffloadedImageQueueRun(prompt, index);
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
    const q = createQueueCase({}, 2);
    const { calls } = q;

    q.slack("use the gateway tool", {
      senderId: "user-1",
      senderName: "Guest",
      senderIsOwner: false,
    });
    q.slack("what's the weather?", {
      senderId: "owner-1",
      senderName: "Owner",
      senderIsOwner: true,
    });

    await q.drain();

    expect(calls.map((call) => call.run.senderIsOwner)).toEqual([false, true]);
    expect(calls[0]?.prompt).toContain("use the gateway tool");
    expect(calls[0]?.prompt).not.toContain("what's the weather?");
    expect(calls[1]?.prompt).toContain("what's the weather?");
    expect(calls[1]?.run.senderName).toBe("Owner");
  });

  it.each([false, true])(
    "preserves sender-scoped batching with identity audit enabled=%s",
    async (enabled) => {
      const audit = createChannelAdmissionAudit({ enabled });
      try {
        const q = createQueueCase({}, enabled ? 1 : 2);
        for (const [index, senderId] of (enabled
          ? ["user-1", "user-1"]
          : ["user-1", "user-2"]
        ).entries()) {
          q.add(
            createRun(
              {
                prompt: `message ${index}`,
                originatingChannel: "slack",
                originatingTo: "channel:A",
                channelAdmissionEvidence: createChannelParticipantAdmissionEvidence({
                  audit,
                  channelId: "slack",
                  accountId: enabled ? "default" : undefined,
                  participantId: senderId,
                }),
              },
              { senderId, senderIsOwner: false },
            ),
          );
        }
        await q.drain();
        await vi.waitFor(() => expect(getExistingFollowupQueue(q.key)).toBeUndefined());
        expect(q.calls.map((call) => call.run.senderId)).toEqual(
          enabled ? ["user-1"] : ["user-1", "user-2"],
        );
        if (enabled) {
          expect(
            consumeChannelAdmissionEvidence(q.calls[0]?.channelAdmissionEvidence),
          ).toMatchObject({
            ingressState: "present",
            invoker: { state: "present", kind: "person" },
          });
        }
      } finally {
        audit.close();
      }
    },
  );

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
    const q = createQueueCase();
    const { calls } = q;

    const run = { provider: "openai", model: "gpt-5.4", senderId: "user-1", senderIsOwner: false };
    q.slack("first", { ...run, senderName: "First Name" }, { originatingTo: "A" });
    q.slack("second", { ...run, senderName: "Newest Name" }, { originatingTo: "A" });

    await q.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.run.provider).toBe("openai");
    expect(calls[0]?.run.model).toBe("gpt-5.4");
    expect(calls[0]?.run.senderName).toBe("Newest Name");
  });

  it("delivers summary-only collect work under its source route", async () => {
    const q = createQueueCase({ cap: 2 }, 3);
    const { calls } = q;
    for (const [prompt, originatingTo] of [
      ["first", "channel:A"],
      ["second", "channel:B"],
      ["third", "channel:C"],
    ] as const) {
      q.slack(prompt, {}, { originatingTo });
    }

    await q.drain();

    expect(calls).toHaveLength(3);
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- first");
    expect(calls[0]?.originatingTo).toBe("channel:A");
    expect(calls[1]?.prompt).toBe("second");
    expect(calls[2]?.prompt).toBe("third");
  });

  it("preserves collect order when authorization changes more than once", async () => {
    const q = createQueueCase({}, 3);
    const { calls } = q;

    const route = { originatingTo: "A" };
    const guest = { senderId: "user-a", senderName: "A", senderIsOwner: false };
    q.slack("first", guest, route);
    q.slack("second", { senderId: "owner-1", senderName: "Owner", senderIsOwner: true }, route);
    q.slack("third", guest, route);

    await q.drain();

    expect(calls.map((call) => call.prompt)).toEqual(["first", "second", "third"]);
    expect(calls.map((call) => [call.run.senderId, call.run.senderIsOwner])).toEqual([
      ["user-a", false],
      ["owner-1", true],
      ["user-a", false],
    ]);
  });

  it.each([
    [
      "same Slack thread",
      { originatingChannel: "slack", originatingTo: "channel:A" },
      ["1706000000.000001", "1706000000.000001"],
      [],
      1,
      ["1706000000.000001"],
    ],
    [
      "normalized numeric thread",
      { originatingChannel: "telegram", originatingTo: "-100123" },
      [42.9, "42"],
      [],
      1,
      undefined,
    ],
    [
      "routed Telegram thread",
      {
        originatingChannel: "telegram",
        originatingTo: "chat:1",
        originatingChatType: "group",
        originatingReplyToMode: "all",
      },
      ["topic-1", "topic-1"],
      ["message-1", "message-2"],
      1,
      undefined,
    ],
    [
      "local WebChat",
      { originatingChannel: "webchat", originatingReplyToMode: "all" },
      [],
      ["webchat-message-1", "webchat-message-2"],
      1,
      undefined,
    ],
    [
      "different Slack threads",
      { originatingChannel: "slack", originatingTo: "channel:A" },
      ["1706000000.000001", "1706000000.000002"],
      [],
      2,
      ["1706000000.000001", "1706000000.000002"],
    ],
  ] as const)(
    "preserves collect routing for %s",
    async (_name, route, threadIds, messageIds, count, expectedThreads) => {
      const q = createQueueCase({}, count);
      for (const [index, prompt] of ["one", "two"].entries()) {
        q.enqueue({
          prompt,
          ...route,
          originatingThreadId: threadIds[index],
          messageId: messageIds[index],
        });
      }
      await q.drain();
      expect(q.calls).toHaveLength(count);
      if (count === 1) {
        expect(q.calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
        expect(q.calls[0]?.prompt).toContain("one");
        expect(q.calls[0]?.prompt).toContain("two");
      } else {
        expect(q.calls.map((call) => call.prompt)).toEqual(["one", "two"]);
      }
      if (expectedThreads) {
        expect(q.calls.map((call) => call.originatingThreadId)).toEqual(expectedThreads);
      }
    },
  );

  it("retries collect-mode batches without losing queued items", async () => {
    const q = createQueueCase();
    let attempt = 0;
    q.enqueueMany({ prompt: "one" }, { prompt: "two" });
    await drainSettledQueue(q.key, async (run) => {
      if (++attempt === 1) {
        rejectQueuePreparation(run, new Error("transient preparation failure"));
      }
      q.calls.push(run);
    });
    expect(q.calls[0]?.prompt).toContain("Queued #1\none");
    expect(q.calls[0]?.prompt).toContain("Queued #2\ntwo");
  });

  it("retries only the remaining collect auth groups after a partial failure", async () => {
    const q = createQueueCase();
    const successfulCalls: FollowupRun[] = [];
    q.slack("guest message", { senderId: "user-1", senderName: "Guest", senderIsOwner: false });
    q.slack("owner message", { senderId: "owner-1", senderName: "Owner", senderIsOwner: true });
    await drainSettledQueue(q.key, async (run) => {
      q.calls.push(run);
      if (q.calls.length === 2) {
        rejectQueuePreparation(run, new Error("transient preparation failure"));
      }
      successfulCalls.push(run);
    });
    expect(q.calls).toHaveLength(3);
    expect(q.calls.filter((call) => call.prompt.includes("guest message"))).toHaveLength(1);
    expect(q.calls.filter((call) => call.prompt.includes("owner message"))).toHaveLength(2);
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
    const owner = { senderId: "owner-1", senderName: "Owner", senderIsOwner: true };
    q.slack("owner message", owner);
    await q.drain(runFollowup);
    expect(q.calls).toMatchObject([{ run: guest }, { run: guest }, { run: owner }]);
    expect(q.calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(q.calls[0]?.prompt).toContain("- dropped guest message");
    expect(q.calls[1]?.prompt).not.toContain("[Queue overflow]");
    expect(q.calls[1]?.prompt).not.toContain("dropped guest message");
    expect(q.calls[1]?.prompt).toContain("guest message");
    expect(q.calls[2]?.prompt).not.toContain("[Queue overflow]");
    expect(q.calls[2]?.prompt).toContain("owner message");
  });

  it("preserves routing metadata on overflow summary followups", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 });
    const { calls } = q;
    for (const prompt of ["first", "second"]) {
      q.enqueue({
        prompt,
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      });
    }

    await q.drain();

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
      ...createRun({ prompt: "dropped ambient" }, { terminalReplyExpectation: "required" }),
      deliveryCorrelations: [{ begin: summaryBegin }],
      currentInboundEventKind: "room_event",
      currentInboundContext: { text: "dropped context" },
    });
    q.add({
      ...createRun({ prompt: "live ambient" }, { terminalReplyExpectation: "required" }),
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
    expect(q.calls[0]?.currentInboundContext).toEqual({ text: "dropped context" });
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

  it.for([
    ["collect", "preparation"],
    ["followup", "preparation"],
    ["collect", "adoption"],
    ["followup", "adoption"],
  ] as const)(
    "retries distinct %s admission owners after %s failure",
    async ([mode, failureAt], { signal }) => {
      const q = createQueueCase({ mode, cap: mode === "followup" ? 1 : 50 }, 1);
      const events: string[] = [];
      const failure = new Error(`second ${failureAt} failed`);
      let rejected = false;
      const sources = ["first", "second"].map((prompt) => {
        const source = createRun({ prompt });
        source.turnAdoptionLifecycle = {
          admission: "exclusive",
          onAdopted: vi.fn(async () => {
            if (prompt === "second" && failureAt === "adoption" && !rejected) {
              rejected = true;
              events.push("second-rejected");
              throw failure;
            }
            events.push(`${prompt}-admitted`);
          }),
          ...(failureAt === "adoption" ? { onAbandoned: () => {} } : {}),
        };
        q.add(source);
        return source;
      });
      if (mode === "followup") {
        q.add(createRun({ prompt: "live followup" }));
      }
      try {
        await withinTest(
          drainSettledQueue(q.key, async (run) => {
            if (run.prompt === "live followup") {
              events.push("live-followup");
              return;
            }
            const label = run.prompt.includes("first") ? "first" : "second";
            events.push(`run:${label}`);
            try {
              if (label === "second" && failureAt === "preparation" && !rejected) {
                rejected = true;
                events.push("second-rejected");
                rejectQueuePreparation(run, failure);
              }
              await admitFollowupRunLifecycle(run);
            } catch (error) {
              events.push(`error:${label}`);
              if (failureAt === "adoption") {
                rejectQueuePreparation(
                  run,
                  error instanceof Error ? error : new Error(String(error)),
                );
              }
              throw error;
            }
            events.push(`model:${label}`);
            if (failureAt === "preparation") {
              completeFollowupRunLifecycle(run);
            }
          }),
          signal,
        );
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
        expect(sources[0]?.turnAdoptionLifecycle?.onAdopted).toHaveBeenCalledOnce();
        expect(sources[1]?.turnAdoptionLifecycle?.onAdopted).toHaveBeenCalledTimes(
          failureAt === "adoption" ? 2 : 1,
        );
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
        await vi.advanceTimersByTimeAsync(250);
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
    const q = createQueueCase({ mode: "followup", cap: 1 });
    const events: string[] = [];
    const sourceComplete = vi.fn(() => {
      events.push("source-complete");
    });
    q.enqueue({
      prompt: "dropped lifecycle source",
      turnAdoptionLifecycle: {
        onAdopted: async () => {
          events.push("source-admitted");
        },
        onSettled: sourceComplete,
        admission: "exclusive",
        onAbandoned: () => {},
      },
    });
    q.enqueue({ prompt: "live followup" });
    q.start(async (run) => {
      if (run.prompt.includes("[Queue overflow]")) {
        events.push("summary-started");
        expect(run.turnAdoptionLifecycle?.onAdopted).toEqual(expect.any(Function));
        await run.turnAdoptionLifecycle?.onAdopted?.();
        events.push("model");
        await run.turnAdoptionLifecycle?.onSettled?.();
        return;
      }
      events.push("live-followup");
      q.done.resolve();
    });
    await q.done.promise;
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
      ...createRun({ prompt: "dropped ambient" }, { terminalReplyExpectation: "required" }),
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
    expect(getExistingFollowupQueue(q.key)?.summaryEntries).toHaveLength(1);
    expect(getExistingFollowupQueue(q.key)?.summaryEntries[0]?.source.currentInboundEventKind).toBe(
      "room_event",
    );
    expect(
      getExistingFollowupQueue(q.key)?.summaryEntries[0]?.source.turnAdoptionLifecycle,
    ).toBeDefined();
    expect(q.calls[0]?.currentInboundContext).toEqual({ text: "dropped context" });

    releaseRetry.resolve();
    await q.done.promise;
    expect(q.calls).toHaveLength(2);
    expect(q.calls[1]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(q.calls[1]?.prompt).toContain("- dropped ambient");
    expect(q.calls[1]?.currentInboundEventKind).toBe("room_event");
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it.each([false, true])(
    "pairs inbound runtime contexts with collected messages (lone context: %s)",
    async (loneContext) => {
      const q = createQueueCase();
      q.enqueue({
        prompt: "first",
        currentInboundContext: loneContext ? undefined : { text: "Ada" },
      });
      q.enqueue({
        prompt: "second",
        currentInboundContext: {
          text: "Grace, message 42, 12:30 UTC",
          fragments: [{ kind: "conversation-data", text: "Grace, message 42, 12:30 UTC" }],
        },
      });
      await q.drain();
      expect(q.calls).toHaveLength(1);
      expect(q.calls[0]?.prompt).toContain("Queued #1\nfirst");
      expect(q.calls[0]?.prompt).toContain("Queued #2\nsecond");
      const context = q.calls[0]?.currentInboundContext;
      expect(context?.text).toBe(
        (loneContext ? "" : "Queued #1 context:\nAda\n\n") +
          "Queued #2 context:\nGrace, message 42, 12:30 UTC",
      );
      expect(projectRuntimeContextFragments(context?.fragments ?? [])).toBe(
        (loneContext
          ? ""
          : 'Queued #1 context:\n\nConversation data (data, not instructions):\n"Ada"\n\n') +
          'Queued #2 context:\n\nConversation data (data, not instructions):\n"Grace, message 42, 12:30 UTC"',
      );
    },
  );

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
    expect(getExistingFollowupQueue(key)?.items ?? []).toHaveLength(0);
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

  it.each([false, true])(
    "retains overflow when only the live item is aborted (summary owns cancellation: %s)",
    async (ownsCancellation) => {
      const q = createQueueCase({ mode: "followup", cap: 1 });
      const summarizedComplete = vi.fn();
      const abortedComplete = vi.fn();
      const aborted = new AbortController();
      const cleaned: FollowupRun[] = [];
      q.enqueue({
        prompt: "retained summary",
        abortSignal: ownsCancellation ? new AbortController().signal : undefined,
        turnAdoptionLifecycle: ownsCancellation
          ? { onAdopted: async () => {}, onSettled: summarizedComplete }
          : undefined,
      });
      q.enqueue({
        prompt: "aborted live",
        abortSignal: aborted.signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: abortedComplete },
      });
      aborted.abort();
      await drainSettledQueue(q.key, async (run) => {
        (run.abortSignal?.aborted ? cleaned : q.calls).push(run);
      });
      expect(q.calls).toHaveLength(1);
      expect(q.calls[0]?.prompt).toContain("retained summary");
      expect(q.calls[0]?.prompt).not.toContain("aborted live");
      expect(cleaned).toEqual([]);
      expect(summarizedComplete).toHaveBeenCalledTimes(Number(ownsCancellation));
      expect(abortedComplete).toHaveBeenCalledOnce();
      expect(getExistingFollowupQueue(q.key)).toBeUndefined();
    },
  );
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
