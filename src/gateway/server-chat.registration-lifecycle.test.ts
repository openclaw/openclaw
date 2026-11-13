import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  emitAgentEventForOwner,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import {
  chatBroadcastCalls,
  createAgentEventTestHarness,
  type AgentEventTestHarnessOptions,
} from "./server-chat.agent-events.test-harness.js";
import { emitAgentEvent, registerChatRun } from "./server-chat.agent-events.test-helpers.js";
import { createChatAbortMarker } from "./server-chat.js";
import { broadcastChatError } from "./server-methods/chat-broadcast.js";

vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));

const persistGatewaySessionLifecycleEventMock = vi.fn();

beforeEach(() => {
  resetAgentEventsForTest({ preserveListeners: true });
  persistGatewaySessionLifecycleEventMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  resetAgentEventsForTest({ preserveListeners: true });
});

function createHarness(params?: AgentEventTestHarnessOptions) {
  const harness = createAgentEventTestHarness({
    ...params,
    persistGatewaySessionLifecycleEventForEvent: persistGatewaySessionLifecycleEventMock,
  });
  onTestFinished(() => harness.handler.dispose());
  return harness;
}

describe("chat run registration lifecycle", () => {
  it("releases finalized hidden run registrations without message subscribers", async () => {
    const h = createHarness();
    for (let index = 0; index < 300; index += 1) {
      const runId = `hidden-run-${index}`;
      h.register(runId, "agent:main:hidden", runId);
      registerAgentRunContext(runId, {
        sessionKey: "agent:main:hidden",
        isControlUiVisible: false,
        projectSessionMessages: true,
        projectSessionLifecycle: false,
      });
      await h.emit(runId, "lifecycle", { phase: "end" });
    }
    expect(h.chat()).toHaveLength(0);
    expect(h.chatRunState.runs.size).toBe(0);
  });

  it.each([false, true])(
    "delivers hidden compaction lifecycle only to its session subscribers (completed=%s)",
    async (completed) => {
      const h = createHarness();
      const runId = "hidden-compaction";
      const sessionKey = "agent:main:hidden-compaction";
      h.register(runId, sessionKey, "client-compaction");
      registerAgentRunContext(runId, {
        sessionKey,
        isControlUiVisible: false,
        projectSessionMessages: true,
        projectSessionLifecycle: false,
      });
      h.sessionMessageSubscribers.subscribe("selected-reader", sessionKey);
      h.sessionMessageSubscribers.subscribe("foreign-reader", "agent:main:other");
      await h.emitMany(runId, [
        ["compaction", { phase: "start", itemId: "recovery-compaction" }],
        ["compaction", { phase: "notice", messages: ["Synthetic private hook notice"] }],
        ["compaction", { phase: "end", itemId: "recovery-compaction", completed }],
      ]);

      const deliveries = h.targetedAgent();
      expect(deliveries.map(([, payload]) => payload)).toEqual([
        expect.objectContaining({
          runId: "client-compaction",
          sessionKey,
          stream: "compaction",
          data: { phase: "start", itemId: "recovery-compaction" },
        }),
        expect.objectContaining({
          runId: "client-compaction",
          sessionKey,
          stream: "compaction",
          data: { phase: "end", itemId: "recovery-compaction", completed },
        }),
      ]);
      for (const delivery of deliveries) {
        expect(delivery[2]).toEqual(new Set(["selected-reader"]));
        expect(delivery[3]).toMatchObject({
          sessionKeys: [sessionKey],
          sessionSubscriptionVerified: true,
        });
      }
      expect(h.broadcast).not.toHaveBeenCalled();
      expect(h.nodeSendToSession).not.toHaveBeenCalled();
      expect(h.targetedChat()).toHaveLength(0);
    },
  );

  it.each(["none", "other-session", "projection-disabled"] as const)(
    "keeps hidden compaction excluded with %s message subscribers",
    async (audience) => {
      const h = createHarness();
      const runId = "hidden-compaction-excluded";
      const sessionKey = "agent:main:hidden-compaction-excluded";
      registerAgentRunContext(runId, {
        sessionKey,
        isControlUiVisible: false,
        projectSessionMessages: audience !== "projection-disabled",
        projectSessionLifecycle: false,
      });
      if (audience !== "none") {
        h.sessionMessageSubscribers.subscribe(
          "reader",
          audience === "other-session" ? "agent:main:other" : sessionKey,
        );
      }
      await h.emitMany(runId, [
        ["compaction", { phase: "start", itemId: "recovery-compaction" }],
        ["compaction", { phase: "end", itemId: "recovery-compaction", completed: true }],
      ]);
      expect(h.targetedAgent()).toHaveLength(0);
      expect(h.broadcast).not.toHaveBeenCalled();
      expect(h.nodeSendToSession).not.toHaveBeenCalled();
    },
  );

  it("does not deliver a hidden compaction end captured before its owner was released", async () => {
    const h = createHarness();
    const runId = "retired-compaction-owner";
    const sessionKey = "agent:main:retired-compaction-owner";
    const claimId = expectDefined(
      claimAgentRunContext(
        runId,
        { sessionKey, isControlUiVisible: false, projectSessionLifecycle: false },
        { exclusive: true, trackOwner: true },
      ),
      "compaction owner claim",
    );
    h.sessionMessageSubscribers.subscribe("selected-reader", sessionKey);
    const captured: AgentEventPayload[] = [];
    const stop = onAgentRuntimeEvent((event) => {
      if (event.runId === runId) {
        captured.push(event);
      }
    });
    try {
      for (const phase of ["start", "end"] as const) {
        expect(
          emitAgentEventForOwner(
            { runId, stream: "compaction", data: { phase, itemId: "retired-compaction" } },
            claimId,
          ),
        ).toBe(true);
      }
      expect(captured).toHaveLength(2);
      await h.handler(expectDefined(captured[0], "captured compaction start"));
      releaseAgentRunContext(runId, claimId);
      await h.handler(expectDefined(captured[1], "captured compaction end"));
      expect(h.targetedAgent().map(([, payload]) => payload.data)).toEqual([
        { phase: "start", itemId: "retired-compaction" },
      ]);
      expect(h.broadcast).not.toHaveBeenCalled();
      expect(h.nodeSendToSession).not.toHaveBeenCalled();
    } finally {
      stop();
      releaseAgentRunContext(runId, claimId);
    }
  });

  it("cancels deferred lifecycle errors when the handler is disposed", async () => {
    vi.useFakeTimers();
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-dispose",
      lifecycleErrorRetryGraceMs: 100,
    });

    await h.emit(
      "run-dispose",
      "lifecycle",
      { phase: "error", error: "retryable provider failure" },
      { sessionKey: "session-dispose", ts: 2_000 },
    );
    expect(vi.getTimerCount()).toBe(1);

    await h.handler.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);

    expect(h.clearAgentRunContext).not.toHaveBeenCalled();
    expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
    expect(h.chat().map(([, payload]) => payload.state)).not.toContain("error");
  });

  it("ignores stale aborted markers from older same-key runs for fresh chat lifecycle events (same-millisecond older sequence)", async () => {
    const h = createHarness({ now: 2_000 });
    h.chatRunState.getOrCreate("client-stale-abort").abortMarker = {
      abortedAtMs: 2_000,
      sequence: -1,
    };
    h.registerNamed("stale-abort");

    await h.emit(
      "run-stale-abort",
      "assistant",
      { text: "Fresh output", delta: "Fresh output" },
      { ts: 2_100 },
    );
    await h.emit("run-stale-abort", "lifecycle", { phase: "end" }, { seq: 2, ts: 2_200 });

    const chatCalls = h.chat();
    expect(chatCalls).toHaveLength(2);
    const deltaPayload = expectDefined(chatCalls[0], "chatCalls[0] test invariant")[1];
    const finalPayload = expectDefined(chatCalls[1], "chatCalls[1] test invariant")[1];
    expect(deltaPayload.state).toBe("delta");
    expect(finalPayload.state).toBe("final");
    expect(h.nodeChat()).toHaveLength(2);
    expect(h.chatRunState.runs.get("client-stale-abort")?.abortMarker).toBeDefined();
    expect(h.chatRunState.registry.peek("run-stale-abort")).toBeUndefined();
  });

  it("honors same-millisecond abort markers from the current same-key run", async () => {
    const h = createHarness({ now: 3_000 });
    h.registerNamed("current-abort");
    h.chatRunState.getOrCreate("client-current-abort").abortMarker = createChatAbortMarker();

    await h.emit(
      "run-current-abort",
      "assistant",
      { text: "Suppressed output", delta: "Suppressed output" },
      { ts: 3_100 },
    );
    await h.emit(
      "run-current-abort",
      "lifecycle",
      { phase: "end", aborted: true, stopReason: "rpc" },
      { seq: 2, ts: 3_200 },
    );

    expect(h.chat()).toHaveLength(0);
    expect(h.nodeChat()).toHaveLength(0);
    expect(h.chatRunState.runs.get("client-current-abort")?.abortMarker).toBeDefined();
    expect(h.chatRunState.registry.peek("run-current-abort")).toBeUndefined();
  });

  it("keeps chat-linked run remapping alive across per-attempt lifecycle errors", async () => {
    vi.useFakeTimers();
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
      lifecycleErrorRetryGraceMs: 100,
    });
    h.register("run-fallback-retry", "session-fallback", "run-fallback-client");

    await h.emitMany("run-fallback-retry", [
      ["assistant", { text: "draft" }],
      ["lifecycle", { phase: "error", error: "provider failed" }],
    ]);

    expect(h.chatRunState.registry.peek("run-fallback-retry")).toMatchObject({
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });
    expect(h.clearAgentRunContext).not.toHaveBeenCalled();
    expect(h.agentRunSeq.get("run-fallback-retry")).toBe(2);

    await h.emit(
      "run-fallback-retry",
      "lifecycle",
      {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
      { seq: 3, sessionKey: "session-fallback" },
    );
    const agentCalls = h.broadcast.mock.calls.filter(([event]) => event === "agent");
    const fallbackPayload = agentCalls.at(-1)?.[1] as {
      runId?: string;
      data?: Record<string, unknown>;
    };
    expect(fallbackPayload.runId).toBe("run-fallback-client");
    expect(fallbackPayload.data?.phase).toBe("fallback");
    expect(h.nodeAgent().at(-1)?.[2]).toMatchObject({
      runId: "run-fallback-client",
      data: { phase: "fallback" },
    });

    vi.advanceTimersByTime(100);

    expect(h.chatRunState.registry.peek("run-fallback-retry")).toMatchObject({
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });
    expect(h.chat().map(([, payload]) => payload.state)).not.toContain("error");
    expect(h.clearAgentRunContext).not.toHaveBeenCalled();
    expect(h.agentRunSeq.get("run-fallback-retry")).toBe(3);

    await h.end("run-fallback-retry", 4);

    expect(h.chat().map(([, payload]) => payload.state)).not.toContain("error");
    const finalPayload = h.chat().at(-1)?.[1] as {
      state?: string;
      runId?: string;
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.runId).toBe("run-fallback-client");
    expect(h.clearAgentRunContext).toHaveBeenCalledWith("run-fallback-retry");
    expect(h.agentRunSeq.has("run-fallback-retry")).toBe(false);
  });

  it.each([
    [false, false],
    [true, true],
  ])(
    "preserves reply-dispatch ownership (delivery=%s, execution=%s)",
    async (settled, executionSettled) => {
      vi.useFakeTimers();
      const trackTrackedRunTerminalPersistence = vi.fn();
      const harness = createHarness({
        resolveSessionKeyForRun: () => "session-reply-dispatch",
        trackTrackedRunTerminalPersistence,
      });
      const { broadcast, chatRunState, clearAgentRunContext, agentRunSeq, handler } = harness;
      const runId = "run-reply-dispatch";
      registerChatRun(chatRunState, runId, "session-reply-dispatch", runId);
      registerAgentRunContext(runId, { sessionKey: "session-reply-dispatch" });
      chatRunState.getOrCreate(runId).buffer = "pending delivered reply";

      await emitAgentEvent(handler, runId, "lifecycle", {
        phase: "error",
        error: "ACP turn failed",
        completionSource: "reply-dispatch",
        ...(executionSettled ? { executionSettled: true } : {}),
      });
      expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledTimes(
        executionSettled ? 1 : 0,
      );
      expect.soft(chatRunState.runs.get(runId)?.buffer).toBe("pending delivered reply");
      expect(agentRunSeq.get(runId)).toBe(1);
      if (settled) {
        broadcastChatError({
          terminalEntry: undefined,
          context: harness,
          runId,
          sessionKey: "session-reply-dispatch",
          errorMessage: "ACP turn failed",
        });
        chatRunState.clearRun(runId);
        chatRunState.registry.remove(runId, runId);
      }

      // Drain pending persistence or legacy grace after the dispatch owner's action.
      await vi.runAllTimersAsync();

      const terminals = chatBroadcastCalls(broadcast);
      expect(terminals).toHaveLength(settled ? 1 : 0);
      if (settled) {
        expect(terminals[0]?.[1]).toMatchObject({ state: "error", seq: 2 });
        expect(agentRunSeq.has(runId)).toBe(false);
      } else {
        expect(chatRunState.runs.get(runId)?.buffer).toBe("pending delivered reply");
        expect(chatRunState.registry.peek(runId)?.clientRunId).toBe(runId);
        expect(agentRunSeq.get(runId)).toBe(1);
      }
      expect(clearAgentRunContext).not.toHaveBeenCalled();
      expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledOnce();
      expect(trackTrackedRunTerminalPersistence).toHaveBeenCalledWith({
        runId,
        clientRunId: runId,
        sessionKey: "session-reply-dispatch",
        sessionId: undefined,
        persistence: expect.any(Promise),
      });
    },
  );
});
