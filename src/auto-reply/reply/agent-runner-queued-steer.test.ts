import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { TurnAdoptionLifecycle } from "../get-reply-options.types.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { createQueuedReplySteer } from "./agent-runner-steer-adoption.js";
import {
  createDrainRecorder,
  createQueueSettings,
  createQueueTestRun,
} from "./queue.test-helpers.js";
import { enqueueFollowupRun, parkSteerCandidate } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type {
  ReplyBackendMessageInjectionV2,
  ReplyBackendQueueMessageResult,
} from "./reply-run-registry.contracts.js";
import { createReplyOperation } from "./reply-run-registry.operation.js";
import { testing } from "./reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createTypingSignaler } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

const keys = new Set<string>();
afterEach(() => {
  for (const key of keys) {
    clearFollowupQueue(key);
  }
  keys.clear();
  testing.resetReplyRunRegistry();
  vi.useRealTimers();
});

function fixture(
  name: string,
  queueMessage: ReplyBackendMessageInjectionV2["queueMessage"],
  enqueueSelected = true,
) {
  vi.useFakeTimers();
  const key = "agent:main:queued-steer-" + name;
  keys.add(key);
  const controller = new AbortController();
  let sourceCurrent = true;
  const run = createQueueTestRun({
    prompt: "approved prepared prompt",
    messageId: " exact-source ",
  });
  run.run.agentId = "main";
  run.run.sessionKey = key;
  run.abortSignal = controller.signal;
  run.operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "source-human",
    scopes: ["operator.write"],
    source: {},
    assertCurrent: () => {
      if (!sourceCurrent) {
        throw new Error("source authority revoked");
      }
    },
  });
  const settled = createDeferredCore();
  const onDeferred = vi.fn<NonNullable<TurnAdoptionLifecycle["onDeferred"]>>();
  const onAdopted = vi.fn();
  run.turnAdoptionLifecycle = { onDeferred, onAdopted, onSettled: () => settled.resolve() };
  const cancel = vi.fn();
  const attach = (runId: string, inject = queueMessage) => {
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: run.run.sessionId,
      resetTriggered: false,
    });
    operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      runId,
      cancel,
      supportsQueueMessageImages: true,
      messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage: inject },
    });
    return operation;
  };
  const operation = attach("active-target");
  const typing = createTypingController({});
  const settings = createQueueSettings({ mode: "followup" });
  run.steer = createQueuedReplySteer({
    followupRun: run,
    opts: { runId: run.messageId },
    queueKey: key,
    replyOperationRunState: {},
    resolvedQueue: settings,
    restartRecoverySourceTurnId: undefined,
    runFollowup: async () => {},
    sessionCtx: {},
    sessionKey: key,
    touchActiveSessionEntry: async () => {},
    typing,
    typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
  });
  const older = createQueueTestRun({ prompt: "older", messageId: "older" });
  const newer = createQueueTestRun({ prompt: "newer", messageId: "newer" });
  for (const source of enqueueSelected ? [older, run, newer] : []) {
    expect(enqueueFollowupRun(key, source, settings, "message-id", undefined, false)).toBe(true);
  }
  return {
    key,
    run,
    older,
    newer,
    operation,
    attach,
    controller,
    settled,
    cancel,
    onDeferred,
    onAdopted,
    settings,
    revokeSource: () => {
      sourceCurrent = false;
    },
    steer: run.steer,
  };
}

describe("retained queued source promotion", () => {
  it("publishes a working promotion control from the real runReplyAgent followup path", async () => {
    const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
      async (_text, _options, assertCurrent) => {
        assertCurrent();
      },
    );
    const f = fixture("entry-point", queueMessage, false);
    const typing = createTypingController({});
    await runReplyAgent({
      commandBody: f.run.prompt,
      followupRun: f.run,
      opts: {
        runId: f.run.messageId,
        operatorAuthority: f.run.operatorAuthority,
        turnAdoptionLifecycle: f.run.turnAdoptionLifecycle,
      },
      queueKey: f.key,
      resolvedQueue: f.settings,
      shouldSteer: false,
      shouldFollowup: true,
      isActive: true,
      typing,
      sessionCtx: {},
      sessionKey: f.key,
      defaultModel: "gpt-test",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "text_end",
      shouldInjectGroupIntro: false,
      typingMode: "never",
    });
    const steer = f.onDeferred.mock.calls[0]?.[0]?.steer;
    if (!steer) {
      throw new Error("Real followup admission did not publish its source control");
    }
    expect(steer).not.toBe(f.steer);
    await expect(steer(() => {})).resolves.toMatchObject({ status: "accepted" });
    await f.settled.promise;
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(queueMessage.mock.calls[0]?.[0]).toBe(f.run.prompt);
    expect(f.onDeferred).toHaveBeenCalledOnce();
  });

  it("rechecks action authority after waiting for an earlier steer", async () => {
    const effect = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(async () => {});
    const f = fixture("predecessor-authority", effect);
    const predecessor = createQueueTestRun({ prompt: "prior steering", messageId: "prior" });
    const fallback = createDrainRecorder(3);
    const pending = parkSteerCandidate(f.key, predecessor, f.settings, fallback.runFollowup)!;
    let current = true;
    const promotion = f.steer(() => {
      if (!current) {
        throw new Error("request authority revoked");
      }
    });
    const rejected = expect(promotion).rejects.toThrow("request authority revoked");
    current = false;
    pending.accepted(true);
    pending.consume("consumed");
    await rejected;
    await fallback.done.promise;
    expect(effect).not.toHaveBeenCalled();
    expect(fallback.calls).toEqual([f.older, f.run, f.newer]);
  });

  it("ACKs custody before transcript commitment, coalesces peers, and preserves prepared media and source authority", async () => {
    const commit = createDeferredCore();
    let retainedAssertion: (() => void) | undefined;
    const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
      async (_text, options, assertCurrent) => {
        assertCurrent();
        retainedAssertion = assertCurrent;
        options?.onQueueAccepted?.(true);
        await commit.promise;
        assertCurrent();
      },
    );
    const f = fixture("media", queueMessage);
    const recorder = createUserTurnTranscriptRecorder({
      message: { role: "user", content: "approved", timestamp: 1 },
      target: () => undefined,
    });
    const confirm = vi
      .spyOn(recorder, "confirmSteerTargetRunIdForPersistence")
      .mockResolvedValue(undefined);
    f.run.userTurnTranscriptRecorder = recorder;
    f.run.images = [{ type: "image", data: "c3ludGhldGlj", mimeType: "image/png" }];
    f.run.imageOrder = ["inline", "offloaded"];
    f.run.media = [{ path: "/synthetic/document.pdf", contentType: "application/pdf" }];
    f.run.currentInboundContext = { text: "original sender context" };
    let requestCurrent = true;
    const requestGuard = () => {
      if (!requestCurrent) {
        throw new Error("RPC ended");
      }
    };
    const first = f.steer(requestGuard);
    expect(f.steer(() => {})).toBe(first);
    await expect(first).resolves.toEqual({ status: "accepted", targetRunId: "active-target" });
    expect(f.steer(() => {})).toBe(first);
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(f.onAdopted).not.toHaveBeenCalled();
    expect(getExistingFollowupQueue(f.key)?.items).toEqual([f.older, f.run, f.newer]);
    expect(queueMessage.mock.calls[0]?.[1]).toMatchObject({
      images: f.run.images,
      imageOrder: f.run.imageOrder,
      media: f.run.media,
      currentInboundContext: f.run.currentInboundContext,
      queueIdentity: " exact-source ",
      userTurnTranscriptRecorder: recorder,
      waitForTranscriptCommit: true,
    });
    requestCurrent = false;
    expect(() => retainedAssertion?.()).not.toThrow();
    commit.resolve();
    await f.settled.promise;
    expect(confirm).toHaveBeenCalledWith("active-target");
    expect(f.onAdopted).toHaveBeenCalledOnce();
    expect(f.onDeferred).toHaveBeenCalledOnce();
    expect(getExistingFollowupQueue(f.key)?.items).toEqual([f.older, f.newer]);
    f.revokeSource();
    expect(() => retainedAssertion?.()).toThrow();
  });

  it("keeps original source authority live after the short control ACK", async () => {
    const release = createDeferredCore();
    const effect = vi.fn();
    const f = fixture("accepted-source-revoked", async (_text, options, assertCurrent) => {
      assertCurrent();
      options?.onQueueAccepted?.(true);
      await release.promise;
      assertCurrent();
      effect();
    });
    await expect(f.steer(() => {})).resolves.toMatchObject({ status: "accepted" });
    f.revokeSource();
    release.resolve();
    await f.settled.promise;
    expect(effect).not.toHaveBeenCalled();
    expect(getExistingFollowupQueue(f.key)?.items).toEqual([f.older, f.newer]);
  });

  it("does not turn a stale source capability into a new send", async () => {
    const effect = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(async () => {});
    const f = fixture("stale-source", effect);
    clearFollowupQueue(f.key);
    await expect(f.steer(() => {})).resolves.toEqual({ status: "not_queued" });
    expect(effect).not.toHaveBeenCalled();
    expect(getExistingFollowupQueue(f.key)).toBeUndefined();
  });

  it("keeps a rejected input at its exact FIFO position without repeating admission", async () => {
    const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(async () => {
      throw new Error("runtime unavailable");
    });
    const f = fixture("rejected", queueMessage);
    await expect(f.steer(() => {})).resolves.toMatchObject({
      status: "queued",
      reason: "runtime_rejected",
    });
    expect(getExistingFollowupQueue(f.key)?.items).toEqual([f.older, f.run, f.newer]);
    expect(f.run.steerPending).toBeUndefined();
    expect(f.onDeferred).toHaveBeenCalledOnce();
    expect(f.onAdopted).not.toHaveBeenCalled();
  });

  it("can retry a rejected promotion even when releasing its steering hold throws", async () => {
    const queueMessage = vi
      .fn<ReplyBackendMessageInjectionV2["queueMessage"]>()
      .mockRejectedValueOnce(new Error("runtime unavailable"))
      .mockResolvedValue(undefined);
    const f = fixture("release-failure", queueMessage);
    const release = vi.fn().mockImplementationOnce(() => {
      throw new Error("steering release failed");
    });
    f.run.turnAdoptionLifecycle!.holdSteering = () => release;
    await expect(f.steer(() => {})).resolves.toMatchObject({ status: "queued" });
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledOnce();
    await expect(f.steer(() => {})).resolves.toMatchObject({ status: "accepted" });
    await f.settled.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(queueMessage).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(getExistingFollowupQueue(f.key)?.items).toEqual([f.older, f.newer]);
  });

  it.each(["receipt", "adoption"] as const)(
    "settles accepted custody without replay when its %s callback rejects",
    async (failure) => {
      const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
        async (_text, options, assertCurrent) => {
          assertCurrent();
          options?.onQueueAccepted?.(true);
        },
      );
      const f = fixture("accepted-callback-" + failure, queueMessage);
      if (failure === "receipt") {
        const recorder = createUserTurnTranscriptRecorder({
          message: { role: "user", content: "approved", timestamp: 1 },
          target: () => undefined,
        });
        vi.spyOn(recorder, "confirmSteerTargetRunIdForPersistence").mockRejectedValue(
          new Error("receipt unavailable"),
        );
        f.run.userTurnTranscriptRecorder = recorder;
      } else {
        f.onAdopted.mockRejectedValue(new Error("adoption unavailable"));
      }
      await expect(f.steer(() => {})).resolves.toMatchObject({ status: "accepted" });
      await f.settled.promise;
      await vi.advanceTimersByTimeAsync(0);
      await expect(f.steer(() => {})).resolves.toEqual({ status: "not_queued" });
      expect(queueMessage).toHaveBeenCalledOnce();
      expect(getExistingFollowupQueue(f.key)?.items).toEqual([f.older, f.newer]);
    },
  );

  it("does not inject into a successor when a predecessor outlives the captured target", async () => {
    const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(async () => {});
    const f = fixture("successor", queueMessage);
    const predecessor = createQueueTestRun({
      prompt: "prior steering",
      messageId: "prior-steering",
    });
    const fallback = createDrainRecorder(3);
    const pending = parkSteerCandidate(f.key, predecessor, f.settings, fallback.runFollowup)!;
    const promotion = f.steer(() => {});
    f.operation.complete();
    const successor = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(async () => {});
    f.attach("successor", successor);
    pending.accepted(true);
    pending.consume("consumed");
    await expect(promotion).resolves.toMatchObject({ status: "queued" });
    await fallback.done.promise;
    expect(queueMessage).not.toHaveBeenCalled();
    expect(successor).not.toHaveBeenCalled();
    expect(fallback.calls).toEqual([f.older, f.run, f.newer]);
  });

  it.each(["request", "source"] as const)(
    "rechecks %s authority at the V2 effect after asynchronous preparation",
    async (who) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const effect = vi.fn();
      const f = fixture("authority-" + who, async (_text, _options, assertCurrent) => {
        entered.resolve();
        await release.promise;
        assertCurrent();
        effect();
      });
      let current = true;
      const promotion = f.steer(() => {
        if (!current) {
          throw new Error("request authority revoked");
        }
      });
      const rejected = expect(promotion).rejects.toThrow(/authority revoked/);
      await entered.promise;
      if (who === "request") {
        current = false;
      } else {
        f.revokeSource();
      }
      release.resolve();
      await rejected;
      expect(effect).not.toHaveBeenCalled();
      expect(getExistingFollowupQueue(f.key)?.items).toEqual([f.older, f.run, f.newer]);
    },
  );

  it.each([false, true])(
    "does not replay accepted input with an unconfirmed receipt (cancelled: %s)",
    async (cancelled) => {
      const receipt = createDeferredCore<void | ReplyBackendQueueMessageResult>();
      const f = fixture("unconfirmed-" + cancelled, async (_text, options, assertCurrent) => {
        assertCurrent();
        options?.onQueueAccepted?.(true);
        return receipt.promise;
      });
      await expect(f.steer(() => {})).resolves.toMatchObject({ status: "accepted" });
      if (cancelled) {
        f.controller.abort();
      }
      receipt.resolve({
        transcriptCommit: "unconfirmed",
        errorMessage: "fixture receipt uncertain",
      });
      await f.settled.promise;
      expect(f.cancel).toHaveBeenCalledOnce();
      expect(getExistingFollowupQueue(f.key)?.items).toEqual([f.older, f.newer]);
    },
  );
});
