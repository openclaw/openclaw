import { expect, it, vi, type Mock } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";
import {
  agentResult,
  expectAgentCall,
  mockLocalSession,
  pendingReply,
  startBackend,
} from "./embedded-backend.stream.test-support.js";
import {
  flushMicrotasks,
  localSessionEntry,
  sendMainChat,
} from "./embedded-backend.test-helpers.js";

type FollowupTestContext = {
  createBackend: () => EmbeddedTuiBackend;
  agentCommandFromIngressMock: Mock;
  loadSessionEntryMock: Mock<typeof localSessionEntry>;
  getSessionControllerOperationMock: Mock;
  steerSessionControllerOperationMock: Mock;
  claimPendingEmbeddedAgentQuestionAnswerMock: Mock;
  updateSessionStoreMock: Mock;
  emitAgentEvent: (event: unknown) => void;
};

export function registerEmbeddedFollowupTests({
  createBackend,
  agentCommandFromIngressMock: runAgent,
  loadSessionEntryMock: loadSession,
  getSessionControllerOperationMock: getOperation,
  steerSessionControllerOperationMock: steer,
  claimPendingEmbeddedAgentQuestionAnswerMock: claimAnswer,
  updateSessionStoreMock: updateStore,
  emitAgentEvent,
}: FollowupTestContext) {
  function prepare(
    overrides: Parameters<typeof mockLocalSession>[1],
    onStart?: (signal?: AbortSignal) => void,
  ) {
    const first = pendingReply(runAgent, onStart);
    const second = pendingReply(runAgent);
    mockLocalSession(loadSession, overrides);
    const { backend, events } = startBackend(createBackend);
    return {
      first,
      second,
      events,
      send: (message: string, runId: string) => sendMainChat(backend, message, runId),
      stop: async () => {
        first.resolve(agentResult());
        second.resolve(agentResult());
        await backend.stop();
      },
    };
  }

  it("keeps local sender identity across steering without sharing it with another client", async () => {
    const first = pendingReply(runAgent);
    getOperation.mockReturnValue({ sessionId: "active-session" });
    steer.mockResolvedValue({ status: "accepted" });
    const { backend } = startBackend(createBackend);
    await sendMainChat(backend, "first", "run-local-first");
    const senderId = runAgent.mock.calls[0]?.[0]?.runContext?.senderId;
    expect(senderId).toEqual(expect.any(String));
    expect(await sendMainChat(backend, "steer this turn", "run-local-second")).toEqual({
      runId: "run-local-first",
    });
    expect(steer.mock.calls[0]?.[0]?.options?.toolAuthorityOverlay).toMatchObject({
      originatingChannel: "webchat",
      messageProvider: "webchat",
      senderId,
      senderIsOwner: false,
      traceAuthorized: false,
      disableTools: false,
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
    first.resolve(agentResult("done"));
    await flushMicrotasks();
    await backend.stop();
    const { backend: otherBackend } = startBackend(createBackend);
    try {
      await sendMainChat(otherBackend, "new client", "run-other-client");
      const otherSenderId = runAgent.mock.calls.at(-1)?.[0]?.runContext?.senderId;
      expect(otherSenderId).toEqual(expect.any(String));
      expect(otherSenderId).not.toBe(senderId);
    } finally {
      await otherBackend.stop();
    }
  });

  it.each(["steer", "collect", "interrupt"] as const)(
    "runs explicit followups separately without changing stored %s behavior",
    async (mode) => {
      const firstAbort = vi.fn();
      const entry = { queueMode: mode, queueDebounceMs: 0 };
      getOperation.mockReturnValue({ sessionId: "active-session" });
      const fixture = prepare(
        () => ({ entry }),
        (signal) => signal?.addEventListener("abort", firstAbort),
      );
      const { first, second, events, send } = fixture;
      runAgent.mockResolvedValueOnce(agentResult("third done"));
      try {
        expect(await send("/followup first", "explicit-first")).toEqual({
          runId: "explicit-first",
        });
        await expectAgentCall(runAgent, 1, { message: "first" });
        expect(events.some((event) => event.event === "agent")).toBe(false);
        const startEvent = {
          runId: "explicit-first",
          stream: "lifecycle",
          data: { phase: "start" },
        };
        emitAgentEvent(startEvent);
        emitAgentEvent(startEvent);
        expect(events.filter((event) => event.event === "agent")).toMatchObject([
          { payload: { data: { phase: "start", explicitFollowup: true } } },
          { payload: { data: { phase: "start" } } },
        ]);
        expect(await send("/followup second\n    detail", "explicit-second")).toEqual({
          runId: "explicit-second",
          status: "queued",
        });
        expect(claimAnswer).not.toHaveBeenCalled();
        if (mode === "collect") {
          await send("third", "ordinary-third");
        }
        expect(steer).not.toHaveBeenCalled();
        expect(firstAbort).not.toHaveBeenCalled();
        expect(updateStore).not.toHaveBeenCalled();
        expect(runAgent).toHaveBeenCalledTimes(1);
        expect(entry.queueMode).toBe(mode);
        first.resolve(agentResult("first done"));
        await expectAgentCall(runAgent, 2, {
          runId: "explicit-second",
          message: "second\n    detail",
        });
        second.resolve(agentResult("second done"));
        if (mode === "collect") {
          await expectAgentCall(runAgent, 3, { message: "third" });
        }
      } finally {
        await fixture.stop();
      }
    },
  );

  it("keeps an explicit followup behind queued work after the active run has finished", async () => {
    await withEnvAsync({ OPENCLAW_TEST_FAST: "0" }, async () => {
      const fixture = prepare(() => ({ entry: { queueMode: "followup", queueDebounceMs: 10 } }));
      const { first, second, events, send } = fixture;
      runAgent.mockResolvedValueOnce(agentResult("third done"));
      try {
        await send("first", "backlog-first");
        await send("second", "backlog-second");
        first.resolve(agentResult("first done"));
        await vi.advanceTimersByTimeAsync(0);
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "chat",
            payload: expect.objectContaining({ runId: "backlog-first", state: "final" }),
          }),
        );
        expect(runAgent).toHaveBeenCalledTimes(1);
        expect(await send("/followup third", "backlog-third")).toEqual({
          runId: "backlog-third",
          status: "queued",
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(runAgent).toHaveBeenCalledTimes(2);
        expect(runAgent.mock.calls[1]?.[0]).toMatchObject({ message: "second" });
        second.resolve(agentResult("second done"));
        await vi.advanceTimersByTimeAsync(10);
        expect(runAgent).toHaveBeenCalledTimes(3);
        expect(runAgent.mock.calls[2]?.[0]).toMatchObject({ message: "third" });
      } finally {
        await fixture.stop();
      }
    });
  });

  it("applies the local queue cap and drop-new policy", async () => {
    const { first, second, send } = prepare(() => ({
      cfg: { messages: { queue: { mode: "followup", cap: 1, drop: "new" } } },
    }));
    await send("first", "run-local-first");
    await send("kept followup", "run-local-second");
    expect(await send("dropped followup", "run-local-third")).toEqual({
      runId: "run-local-second",
    });
    await expect(send("/followup must not disappear", "explicit-rejected")).rejects.toThrow(
      "Your followup was not queued because the session queue is full.",
    );
    first.resolve(agentResult("first done"));
    await expectAgentCall(runAgent, 2, { message: "kept followup" });
    second.resolve(agentResult("second done"));
    await flushMicrotasks();
  });
}
