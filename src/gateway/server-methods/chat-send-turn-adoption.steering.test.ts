import { describe, expect, it, vi } from "vitest";
import type { ChatSteerResult } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createChatSendTurnAdoptionLifecycle } from "./chat-send-turn-adoption.js";

function fixture(sessionKey: string) {
  const context = createDirectChatContext({ getRuntimeConfig: () => ({}) });
  const controller = new AbortController();
  const release = vi.fn();
  const retain = vi.fn(() => release);
  const source = createChatSendTurnAdoptionLifecycle({
    accountId: undefined,
    context,
    chatQueuedTurns: context.chatQueuedTurns,
    runId: "source",
    controller,
    sessionBinding: {
      sessionId: "original-session",
      sessionKey,
      agentId: "main",
      lifecycleGeneration: "fixture",
    },
    sessionKey,
    agentId: "main",
    originatingChannel: "webchat",
    session: {
      agentId: "main",
      backingSessionId: "original-session",
      cfg: {},
      clientRunId: "source",
      sessionKey,
      sessionLoadOptions: { agentId: "main" },
    },
    hasCronCreatorAuthority: false,
    suppressReplies: true,
    retainWorkAdmission: retain,
  });
  const steer = vi.fn(async (): Promise<ChatSteerResult> => ({ status: "accepted" }));
  const run = createQueueTestRun({ prompt: "prepared input", messageId: "source" });
  run.turnAdoptionLifecycle = source.lifecycle;
  run.abortSignal = controller.signal;
  run.steer = steer;
  expect(
    enqueueFollowupRun(sessionKey, run, createQueueSettings(), "message-id", undefined, false),
  ).toBe(true);
  const entry = context.chatQueuedTurns.get("source");
  if (!entry) {
    throw new Error("Missing original queued source");
  }
  return { entry, source, controller, release, retain, steer, context };
}

describe("queued Gateway steering lifecycle", () => {
  it("publishes the original source capability once and interlocks withdrawal through steering settlement", async () => {
    const key = "agent:main:steer-withdrawal";
    const f = fixture(key);
    try {
      expect(f.entry.steer).toBe(f.steer);
      expect(f.retain).toHaveBeenCalledOnce();
      const withdraw = f.entry.holdPendingInputWithdrawal?.();
      expect(withdraw).toBeTypeOf("function");
      expect(f.source.lifecycle.holdSteering?.()).toBeUndefined();
      withdraw?.();
      const settleSteering = f.source.lifecycle.holdSteering?.();
      expect(settleSteering).toBeTypeOf("function");
      expect(f.entry.holdPendingInputWithdrawal?.()).toBeUndefined();
      // A quick accepted ACK must not release the lifecycle's independent hold.
      await expect(f.entry.steer?.(() => {})).resolves.toEqual({ status: "accepted" });
      expect(f.entry.holdPendingInputWithdrawal?.()).toBeUndefined();
      settleSteering?.();
      const afterRejection = f.entry.holdPendingInputWithdrawal?.();
      expect(afterRejection).toBeTypeOf("function");
      afterRejection?.();
      await f.source.lifecycle.onAdopted();
      expect(f.source.lifecycle.holdSteering?.()).toBeUndefined();
      expect(f.entry.holdPendingInputWithdrawal?.()).toBeUndefined();
    } finally {
      clearFollowupQueue(key);
    }
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.context.chatQueuedTurns.has("source")).toBe(false);
  });

  it("retains original work admission after queue consumption until promotion settlement", () => {
    const key = "agent:main:steer-settlement-hold";
    const f = fixture(key);
    const releaseSteering = f.source.lifecycle.holdSteering?.();
    expect(releaseSteering).toBeTypeOf("function");
    expect(f.retain).toHaveBeenCalledTimes(2);
    clearFollowupQueue(key);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.context.chatQueuedTurns.has("source")).toBe(false);
    expect(f.source.lifecycle.holdSteering?.()).toBeUndefined();
    releaseSteering?.();
    releaseSteering?.();
    expect(f.release).toHaveBeenCalledTimes(2);
  });

  it("keeps withdrawal first while cancellation prevents later source adoption", async () => {
    const key = "agent:main:steer-cancelled-withdrawal";
    const f = fixture(key);
    try {
      const withdraw = f.entry.holdPendingInputWithdrawal?.();
      const adopted = f.source.lifecycle.onAdopted();
      const rejected = expect(adopted).rejects.toThrow();
      expect(f.source.lifecycle.holdSteering?.()).toBeUndefined();
      f.controller.abort(new Error("withdrawn"));
      withdraw?.();
      await rejected;
      expect(f.steer).not.toHaveBeenCalled();
      expect(f.source.lifecycle.holdSteering?.()).toBeUndefined();
      expect(f.context.chatQueuedTurns.has("source")).toBe(false);
    } finally {
      clearFollowupQueue(key);
    }
    expect(f.release).toHaveBeenCalledOnce();
  });
});
