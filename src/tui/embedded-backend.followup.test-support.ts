import { expect, it, vi, type Mock } from "vitest";
import { createDeferred as deferred } from "../../test/helpers/promise.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";
import { captureBackendEvents } from "./embedded-backend.stream.test-support.js";
import {
  flushMicrotasks,
  localSessionEntry,
  sendMainChat,
} from "./embedded-backend.test-helpers.js";

type EmbeddedAgentResult = {
  payloads: Array<{ text: string }>;
  meta: Record<string, unknown>;
};

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
  agentCommandFromIngressMock,
  loadSessionEntryMock,
  getSessionControllerOperationMock,
  steerSessionControllerOperationMock,
  claimPendingEmbeddedAgentQuestionAnswerMock,
  updateSessionStoreMock,
  emitAgentEvent,
}: FollowupTestContext) {
  it("keeps local sender identity across steering without sharing it with another client", async () => {
    const first = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(first.promise);
    getSessionControllerOperationMock.mockReturnValue({ sessionId: "active-session" });
    steerSessionControllerOperationMock.mockResolvedValue({ status: "accepted" });

    const backend = createBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");
    const senderId = agentCommandFromIngressMock.mock.calls[0]?.[0]?.runContext?.senderId;
    expect(senderId).toEqual(expect.any(String));

    const result = await sendMainChat(backend, "steer this turn", "run-local-second");

    expect(result).toEqual({ runId: "run-local-first" });
    expect(
      steerSessionControllerOperationMock.mock.calls[0]?.[0]?.options?.toolAuthorityOverlay,
    ).toMatchObject({
      originatingChannel: "webchat",
      messageProvider: "webchat",
      senderId,
      senderIsOwner: false,
      traceAuthorized: false,
      disableTools: false,
    });
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    first.resolve({ payloads: [{ text: "done" }], meta: {} });
    await flushMicrotasks();
    await backend.stop();
    const otherBackend = createBackend();
    otherBackend.start();
    try {
      await sendMainChat(otherBackend, "new client", "run-other-client");
      const otherSenderId =
        agentCommandFromIngressMock.mock.calls.at(-1)?.[0]?.runContext?.senderId;
      expect(otherSenderId).toEqual(expect.any(String));
      expect(otherSenderId).not.toBe(senderId);
    } finally {
      await otherBackend.stop();
    }
  });

  it.each(["steer", "collect", "interrupt"] as const)(
    "runs explicit followups separately without changing stored %s behavior",
    async (mode) => {
      const first = deferred<EmbeddedAgentResult>();
      const second = deferred<EmbeddedAgentResult>();
      const firstAbort = vi.fn();
      agentCommandFromIngressMock
        .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
          opts.abortSignal?.addEventListener("abort", firstAbort);
          return first.promise;
        })
        .mockReturnValueOnce(second.promise)
        .mockResolvedValueOnce({ payloads: [{ text: "third done" }], meta: {} });
      const entry = { queueMode: mode, queueDebounceMs: 0 };
      loadSessionEntryMock.mockImplementation((sessionKey, opts) =>
        localSessionEntry(sessionKey, opts, { entry }),
      );
      getSessionControllerOperationMock.mockReturnValue({ sessionId: "active-session" });
      const backend = createBackend();
      const events = captureBackendEvents(backend);
      backend.start();
      try {
        expect(await sendMainChat(backend, "/followup first", "explicit-first")).toEqual({
          runId: "explicit-first",
        });
        await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1));
        expect(agentCommandFromIngressMock.mock.calls[0]?.[0]).toMatchObject({ message: "first" });
        expect(events.some((event) => event.event === "agent")).toBe(false);
        const startEvent = {
          runId: "explicit-first",
          stream: "lifecycle",
          data: { phase: "start" },
        };
        emitAgentEvent(startEvent);
        emitAgentEvent(startEvent);
        expect(events.filter((event) => event.event === "agent")).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({ data: { phase: "start", explicitFollowup: true } }),
          }),
          expect.objectContaining({
            payload: expect.objectContaining({ data: { phase: "start" } }),
          }),
        ]);
        expect(
          await sendMainChat(backend, "/followup second\n    detail", "explicit-second"),
        ).toEqual({
          runId: "explicit-second",
          status: "queued",
        });
        expect(claimPendingEmbeddedAgentQuestionAnswerMock).not.toHaveBeenCalled();
        if (mode === "collect") {
          await sendMainChat(backend, "third", "ordinary-third");
        }
        expect(steerSessionControllerOperationMock).not.toHaveBeenCalled();
        expect(firstAbort).not.toHaveBeenCalled();
        expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
        expect(entry.queueMode).toBe(mode);
        expect(updateSessionStoreMock).not.toHaveBeenCalled();
        first.resolve({ payloads: [{ text: "first done" }], meta: {} });
        await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2));
        expect(agentCommandFromIngressMock.mock.calls[1]?.[0]).toMatchObject({
          runId: "explicit-second",
          message: "second\n    detail",
        });
        second.resolve({ payloads: [{ text: "second done" }], meta: {} });
        if (mode === "collect") {
          await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(3));
          expect(agentCommandFromIngressMock.mock.calls[2]?.[0]).toMatchObject({
            message: "third",
          });
        }
      } finally {
        first.resolve({ payloads: [], meta: {} });
        second.resolve({ payloads: [], meta: {} });
        await backend.stop();
      }
    },
  );

  it("keeps an explicit followup behind queued work after the active run has finished", async () => {
    await withEnvAsync({ OPENCLAW_TEST_FAST: "0" }, async () => {
      const first = deferred<EmbeddedAgentResult>();
      const second = deferred<EmbeddedAgentResult>();
      agentCommandFromIngressMock
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockResolvedValueOnce({ payloads: [{ text: "third done" }], meta: {} });
      loadSessionEntryMock.mockImplementation((sessionKey, opts) =>
        localSessionEntry(sessionKey, opts, {
          entry: { queueMode: "followup", queueDebounceMs: 10 },
        }),
      );
      const backend = createBackend();
      const events = captureBackendEvents(backend);
      backend.start();
      try {
        await sendMainChat(backend, "first", "backlog-first");
        await sendMainChat(backend, "second", "backlog-second");
        first.resolve({ payloads: [{ text: "first done" }], meta: {} });
        await vi.advanceTimersByTimeAsync(0);
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "chat",
            payload: expect.objectContaining({ runId: "backlog-first", state: "final" }),
          }),
        );
        expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
        expect(await sendMainChat(backend, "/followup third", "backlog-third")).toEqual({
          runId: "backlog-third",
          status: "queued",
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
        expect(agentCommandFromIngressMock.mock.calls[1]?.[0]).toMatchObject({ message: "second" });
        second.resolve({ payloads: [{ text: "second done" }], meta: {} });
        await vi.advanceTimersByTimeAsync(10);
        expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(3);
        expect(agentCommandFromIngressMock.mock.calls[2]?.[0]).toMatchObject({ message: "third" });
      } finally {
        first.resolve({ payloads: [], meta: {} });
        second.resolve({ payloads: [], meta: {} });
        await backend.stop();
      }
    });
  });
}

export function registerEmbeddedQueueCapTest({
  createBackend,
  agentCommandFromIngressMock,
  loadSessionEntryMock,
}: FollowupTestContext) {
  it("applies the local queue cap and drop-new policy", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const second = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    loadSessionEntryMock.mockImplementation((sessionKey, opts) =>
      localSessionEntry(sessionKey, opts, {
        cfg: {
          messages: { queue: { mode: "followup", cap: 1, drop: "new" } },
        },
      }),
    );

    const backend = createBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");
    await sendMainChat(backend, "kept followup", "run-local-second");
    const dropped = await sendMainChat(backend, "dropped followup", "run-local-third");

    expect(dropped).toEqual({ runId: "run-local-second" });
    await expect(
      sendMainChat(backend, "/followup must not disappear", "explicit-rejected"),
    ).rejects.toThrow("Your followup was not queued because the session queue is full.");
    first.resolve({ payloads: [{ text: "first done" }], meta: {} });
    await vi.waitFor(() => {
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
    });
    expect(agentCommandFromIngressMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ message: "kept followup" }),
    );
    second.resolve({ payloads: [{ text: "second done" }], meta: {} });
    await flushMicrotasks();
  });
}
