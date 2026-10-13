import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createQueueCase } from "./queue.case.test-support.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  refreshQueuedFollowupSession,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  createQueueTestRun as createRun,
  createQueueSettings,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resolveFollowupDeliveryStorageKey } from "./queue/delivery-context.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type { QueuedFollowupReplyBatch } from "./queue/types.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
type InternalFollowupRun = FollowupRun & {
  currentTurnImagesPrepared?: true;
  mediaImageLayout?: {
    slots: Array<{ kind: "inline" | "offloaded"; factIndex?: number }>;
    suppressedFactIndexes: number[];
  };
};
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-overflow-session-");
installQueueRuntimeErrorSilencer();
describe("followup queue collect routing", () => {
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

  it.each(["admission", "callback failure"] as const)(
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
      "followup run lifecycle completed before admission",
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
    expect(getExistingFollowupQueue(key)?.items).toEqual([]);
    clearFollowupQueue(key);
  });

  it("splits standalone Slack collect batches by message id", async () => {
    const replyToMode = "first";
    const originatingChannel = " Slack ";
    const q = createQueueCase();
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
        originatingChatType: "channel",
      });
    }
    q.start(async (run) => {
      q.calls.push(run);
      if (q.calls.length === 2) {
        q.done.resolve();
      }
    });
    await q.done.promise;
    expect(q.calls.map((call) => call.prompt)).toEqual(["one", "two"]);
    expect(q.calls.map((call) => call.messageId)).toEqual(["101.001", "101.002"]);
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

  it("does not register a drop:new source that the full queue rejects", () => {
    const q = createQueueCase({ mode: "followup", cap: 1, dropPolicy: "new" }, 1);
    const onEnqueued = vi.fn();
    const onAbandoned = vi.fn();
    const onDisposition = vi.fn();
    const onComplete = vi.fn();
    expect(q.add(createRun({ prompt: "existing" }))).toBe(true);
    expect(
      q.add({
        ...createRun({ prompt: "rejected" }),
        onQueueDisposition: onDisposition,
        turnAdoptionLifecycle: {
          onAdopted: async () => {},
          onDeferred: onEnqueued,
          onAbandoned,
          onSettled: onComplete,
        },
      }),
    ).toBe(false);
    expect(onEnqueued).not.toHaveBeenCalled();
    expect(onDisposition).toHaveBeenCalledWith("queue-cap-new");
    expect(onAbandoned).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(getExistingFollowupQueue(q.key)?.items.map((item) => item.prompt)).toEqual(["existing"]);
    clearFollowupQueue(q.key);
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
      await q.drain();
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
    q.add({
      ...droppedBase,
      abortSignal: controller.signal,
      currentInboundContext: { text: "private runtime context" },
      run: { ...droppedBase.run, model: "old-model", senderId: "guest", senderIsOwner: false },
    });
    q.slack(
      "public channel content",
      { model: "old-model", senderId: "owner", senderIsOwner: true },
      { originatingTo: "same-target", originatingChatType: "channel" },
    );
    controller.abort();
    refreshQueuedFollowupSession({ key: q.key, nextModel: "current-model" });
    await q.drain();
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

  it("keeps deferred overflow summary text paired with its source route", async () => {
    const q = createQueueCase({ cap: 1 });
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
      q.calls.push(run);
      if (q.calls.length === 1) {
        q.enqueue({
          prompt: "surviving C",
          originatingChannel: "slack",
          originatingTo: "same-target",
          originatingChatType: "channel",
        });
        throw new FollowupRunDeferredError();
      }
      if (q.calls.length >= 3) {
        q.done.resolve();
      }
    });
    await q.done.promise;
    expect(q.calls[1]?.prompt).toContain("- source B");
    expect(q.calls[1]?.prompt).not.toContain("source A");
    expect(q.calls[1]?.originatingChatType).toBe("direct");
    expect(q.calls[2]?.prompt).toContain("surviving C");
    expect(q.calls[2]?.prompt).not.toContain("source A");
    expect(q.calls[2]?.prompt).not.toContain("source B");
    expect(q.calls[2]?.originatingChatType).toBe("channel");
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
        throw new Error("transient failure");
      }
      q.calls.push(run);
      if (q.calls.length >= 3) {
        q.done.resolve();
      }
    };
    const guest = { senderId: "user-1", senderName: "Guest", senderIsOwner: false };
    q.slack("dropped guest message", guest);
    q.slack("guest message", guest);
    q.slack("owner message", { senderId: "owner-1", senderName: "Owner", senderIsOwner: true });
    await q.drain(runFollowup);
    expect(q.calls).toHaveLength(3);
    expect(q.calls.map((run) => [run.run.senderId, run.run.senderIsOwner])).toEqual([
      ["user-1", false],
      ["user-1", false],
      ["owner-1", true],
    ]);
    expect(q.calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(q.calls[0]?.prompt).toContain("- dropped guest message");
    expect(q.calls[1]?.prompt).not.toContain("[Queue overflow]");
    expect(q.calls[1]?.prompt).not.toContain("dropped guest message");
    expect(q.calls[1]?.prompt).toContain("guest message");
    expect(q.calls[2]?.prompt).not.toContain("[Queue overflow]");
    expect(q.calls[2]?.prompt).toContain("owner message");
  });

  it("keeps live item runtime metadata out of standalone overflow summaries", async () => {
    const q = createQueueCase({ cap: 1 }, 1);
    const controller = new AbortController();
    const onComplete = vi.fn();
    const begin = vi.fn(() => () => undefined);
    const runFollowup = async (run: FollowupRun) => {
      q.calls.push(run);
      if (q.calls.length >= 2) {
        q.done.resolve();
      }
    };
    q.add({
      ...createRun({ prompt: "dropped ambient" }),
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
    expect(q.calls[1]?.prompt).toBe("live ambient");
    expect(q.calls[1]?.currentInboundEventKind).toBe("room_event");
    expect(q.calls[1]?.currentInboundAudio).toBe(true);
    expect(q.calls[1]?.currentInboundContext?.text).toBe("live context");
    expect(q.calls[1]?.abortSignal).toBe(controller.signal);
    expect(q.calls[1]?.turnAdoptionLifecycle?.onSettled).toBe(onComplete);
    expect(q.calls[1]?.deliveryCorrelations?.[0]?.begin).toBe(begin);
  });

  it.each(["collect", "followup"] as const)(
    "retries distinct %s admission owners independently",
    async (mode) => {
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
        onAdopted: vi
          .fn<() => Promise<void>>()
          .mockImplementationOnce(async () => {
            events.push("second-rejected");
            throw new Error("second admission failed");
          })
          .mockImplementationOnce(async () => {
            events.push("second-admitted");
          }),
      };
      q.add(first);
      q.add(second);
      if (mode === "followup") {
        q.add(createRun({ prompt: "live followup" }));
      }
      q.start(async (run) => {
        if (run.prompt === "live followup") {
          events.push("live-followup");
          q.done.resolve();
          return;
        }
        const label = run.prompt.includes("first") ? "first" : "second";
        events.push(`run:${label}`);
        try {
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
      await q.done.promise;
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
      expect(second.turnAdoptionLifecycle.onAdopted).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps queue cancellation connected after collect admission", async () => {
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
        return;
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

  it("removes an aborted elided source without leaking it into the summary", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 }, 1);
    const elidedComplete = vi.fn();
    const elided = new AbortController();
    const runFollowup = async (run: FollowupRun) => {
      if (run.abortSignal?.aborted) {
        return;
      }
      q.calls.push(run);
      if (q.calls.length === 2) {
        q.done.resolve();
      }
    };
    q.add({
      ...createRun({ prompt: "elided and cancelled" }),
      abortSignal: elided.signal,
      turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: elidedComplete },
    });
    q.add(createRun({ prompt: "retained summary" }));
    q.add(createRun({ prompt: "live item" }));
    elided.abort();
    await q.drain(runFollowup);
    expect(q.calls.map((call) => call.prompt).join("\n")).not.toContain("elided and cancelled");
    expect(q.calls[0]?.prompt).toContain("retained summary");
    expect(q.calls[1]?.prompt).toBe("live item");
    expect(elidedComplete).toHaveBeenCalledTimes(1);
  });

  it("does not replay elided sources after an admitted summary failure", async () => {
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
    const firstCorrelation = { begin: vi.fn() };
    const secondCorrelation = { begin: vi.fn() };
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
    expect(q.calls[0]?.deliveryCorrelations).toEqual([firstCorrelation, secondCorrelation]);
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

  it("keeps one onComplete-only overflow source retryable after delivery fails", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 }, 1);
    const firstAttempt = createDeferred();
    const releaseRetry = createDeferred();
    const onComplete = vi.fn();
    let attempts = 0;
    const runFollowup = async (run: FollowupRun) => {
      q.calls.push(run);
      expect(run.turnAdoptionLifecycle).toBeUndefined();
      attempts += 1;
      if (attempts === 1) {
        firstAttempt.resolve();
        throw new Error("transient failure");
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
    expect(
      getExistingFollowupQueue(q.key)?.summarySources[0]?.currentInboundContext,
    ).toBeUndefined();
    q.start(runFollowup);
    releaseRetry.resolve();
    await q.done.promise;
    expect(q.calls).toHaveLength(2);
    expect(q.calls[1]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(q.calls[1]?.prompt).toContain("- dropped ambient");
    expect(q.calls[1]?.currentInboundEventKind).toBe("room_event");
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledTimes(1);
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
