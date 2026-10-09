import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  emitAgentEvent as emitRuntimeAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  clearAgentRunContext as clearRegisteredAgentRunContext,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { abortChatRunById, registerChatAbortController } from "./chat-abort.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "./server-chat.agent-events.test-helpers.js";
import type { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

// mock-isolation: Publication tests use injected persistence without operator config or SQLite.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
// mock-isolation: No restart marker exists in this fixture; the real admission owner still orders reads.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async () => undefined,
}));

describe("single lifecycle publication", () => {
  const persistGatewaySessionLifecycleEventMock = vi.fn<typeof persistGatewaySessionLifecycleEvent>(
    async () => {},
  );
  beforeEach(() => {
    resetAgentEventsForTest();
    persistGatewaySessionLifecycleEventMock.mockClear();
  });
  afterEach(() => resetAgentEventsForTest());

  function createHarness() {
    return createAgentEventTestHarness({
      persistGatewaySessionLifecycleEventForEvent: persistGatewaySessionLifecycleEventMock,
    });
  }

  it("reserves the RPC abort terminal before synchronous lifecycle errors", async () => {
    const stopReason = "rpc";
    const h = createHarness();
    const runId = "run-abort-publication";
    const sessionKey = "session-abort-publication";
    const chatAbortControllers = new Map();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      sessionKey,
      sessionId: "session-id",
      timeoutMs: 60_000,
    });
    const unlisten = subscribeAgentEvents(h.handler);
    onTestFinished(unlisten);
    const observedPhases: unknown[] = [];
    onTestFinished(onAgentRuntimeEvent((event) => observedPhases.push(event.data.phase)));
    await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
      registerAgentRunContext(runId, { sessionKey, sessionId: "session-id" });
      h.register(runId, sessionKey, runId);
      registration.markExecutionStarted();
      emitRuntimeAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: Date.now() },
      });
      await unlisten.drain();
      registration.controller.signal.addEventListener("abort", () => {
        emitRuntimeAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "error", aborted: true, stopReason: "aborted", executionSettled: true },
        });
        clearRegisteredAgentRunContext(runId);
      });
      expect(
        abortChatRunById(
          {
            ...h,
            chatAbortControllers,
            removeChatRun: h.chatRunState.registry.remove,
          },
          { runId, sessionKey, stopReason },
        ),
      ).toEqual({ aborted: true });
      expect(observedPhases).toEqual(["start", "error", "end"]);
      for (const data of [
        { phase: "model", provider: null, model: null },
        { phase: "finishing" },
        { phase: "error", aborted: true, stopReason: "aborted", executionSettled: true },
      ]) {
        emitRuntimeAgentEvent({ runId, stream: "lifecycle", data });
      }
      await unlisten.drain();
    });
    expect(h.agent().map(([, event]) => event.data)).toEqual([
      expect.objectContaining({ phase: "start" }),
      expect.objectContaining({ phase: "end", status: "cancelled", aborted: true, stopReason }),
    ]);
    expect(h.agent().map(([, event]) => event.seq)).toEqual([1, 3]);
    expect(h.nodeAgent()).toHaveLength(2);
    expect(h.chat().filter(([, event]) => event.state === "aborted")).toHaveLength(1);
    expect(h.clearAgentRunContext).toHaveBeenCalledWith(runId);
    expect(persistGatewaySessionLifecycleEventMock.mock.calls.at(-1)?.[0].event.data).toMatchObject(
      {
        phase: "error",
        executionSettled: true,
      },
    );
  });

  it.each([false, true])(
    "suppresses every client lifecycle projection after the terminal (hidden=%s)",
    async (hidden) => {
      const h = createHarness();
      const runId = "run-single-projection";
      const sessionKey = "session-single-projection";
      h.sessionEventSubscribers.subscribe("session-observer");
      h.sessionMessageSubscribers.subscribe("message-observer", sessionKey);
      const unlisten = subscribeAgentEvents(h.handler);
      onTestFinished(unlisten);
      await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
        registerAgentRunContext(runId, { sessionKey, isControlUiVisible: !hidden });
        emitRuntimeAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        await unlisten.drain();
        const changes = h.changes().length;
        expect(changes).toBe(1);
        for (const data of [{ phase: "end" }, { phase: "start", startedAt: 2 }]) {
          emitRuntimeAgentEvent({ runId, stream: "lifecycle", data });
          await unlisten.drain();
        }
        expect(h.changes()).toHaveLength(changes);
      });
      const agent = hidden ? h.targetedAgent() : h.agent();
      const chat = hidden ? h.targetedChat() : h.chat();
      expect(agent.map(([, event]) => event.data.phase)).toEqual(["end"]);
      expect(chat.map(([, event]) => event.state)).toEqual(["final"]);
      expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledTimes(2);
      expect(h.clearAgentRunContext).toHaveBeenCalledTimes(2);
    },
  );
});
