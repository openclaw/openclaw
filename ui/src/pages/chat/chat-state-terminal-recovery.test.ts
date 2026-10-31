import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { handlePageGatewayEvent } from "./chat-state-events.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  createSessionEventState,
  emitGatewayEvent,
  renderedTranscript,
} from "./chat-state.test-support.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";

const historyBudget = { limit: 80, maxBytes: 256 * 1024, toolResultMaxChars: 2_000 };

// Keep history ordering/count assertions independent of auxiliary post-run auth reads.
function withAuthStatus(request: GatewayRequestHandler): GatewayRequestHandler {
  return (method, ...args) =>
    method === "models.authStatus"
      ? Promise.resolve({ ts: 0, providers: [] })
      : request(method, ...args);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("terminal reply recovery", () => {
  function createRecoveryPrompt(runId: string, text: string, seq = 1) {
    return {
      role: "user",
      content: [{ type: "text", text }],
      __openclaw: { id: "prompt-1", idempotencyKey: `${runId}:user`, seq },
    };
  }

  function createTerminalHistory(messages: unknown[], sessionKey = "agent:main:main") {
    return {
      messages,
      sessionId: "selected-session",
      sessionInfo: {
        key: sessionKey,
        kind: sessionKey === "global" ? ("global" as const) : ("direct" as const),
        updatedAt: 2,
        hasActiveRun: false,
        activeRunIds: [],
        status: "done" as const,
      },
    };
  }

  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
  const retired = (text: string) => ({ ...assistant(text), openclawDisplayContent: [] });
  const reply = (runId: string, content: unknown) => ({
    role: "assistant",
    content,
    stopReason: "stop",
    __openclaw: { id: "reply-1", runId, seq: 2 },
  });
  const transcript = (...turns: [role: string, text: string][]) =>
    turns.map(([role, text]) => ({ role, text }));
  function event(state: ChatPageHost, payload: object, presented = true) {
    return () =>
      handlePageGatewayEvent(
        state,
        {
          type: "event",
          event: "chat",
          payload: { sessionKey: state.sessionKey, ...payload },
        },
        () => presented,
      );
  }
  function fixture(
    runId: string,
    promptText: string,
    replyContent: unknown,
    overrides: Partial<ChatPageHost> = {},
    authenticated = false,
  ) {
    const prompt = createRecoveryPrompt(runId, promptText);
    const persistedReply = reply(runId, replyContent);
    const request = vi.fn().mockResolvedValue(createTerminalHistory([prompt, persistedReply]));
    const { state } = createSessionEventState({
      chatMessages: [prompt],
      chatHistoryPagination: { hasMore: false },
      chatRunId: runId,
      pendingSessionMessageReloadSessionKey: null,
      client: authenticated
        ? createTestGatewayClient(withAuthStatus(request))
        : ({ request: withAuthStatus(request) } as unknown as GatewayBrowserClient),
      ...overrides,
    });
    return { prompt, persistedReply, request, state };
  }

  it.each([
    ["omitted", undefined, true],
    ["null", null, true],
    ["retired while idle", retired("Saved reply"), false],
    ["retired while active", retired("The durable reply must appear below Done."), true],
    ["omitted while idle", undefined, false],
  ] as const)(
    "recovers the durable reply when the terminal message is %s",
    async (_name, terminalMessage, startsActive) => {
      const runId = "run-with-message-less-terminal";
      const replyText = "The durable reply must appear below Done.";
      const { request, state } = fixture(
        runId,
        "Finish the dashboard task",
        assistant(replyText).content,
        { chatRunId: startsActive ? runId : null },
      );
      const terminal = {
        sessionKey: state.sessionKey,
        runId,
        state: "final",
        message: terminalMessage,
      };
      emitGatewayEvent(state, "chat", terminal);

      expect(state.chatRunId).toBeNull();
      expect(renderedTranscript(state)).toEqual(transcript(["user", "Finish the dashboard task"]));
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "chat.history",
          {
            sessionKey: state.sessionKey,
            knownState: {},
            ...historyBudget,
          },
          { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
        ),
      );
      await vi.waitFor(() => expect(state.chatLoading).toBe(false));
      expect(request).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(renderedTranscript(state)).toEqual(
          transcript(["user", "Finish the dashboard task"], ["assistant", replyText]),
        ),
      );

      request.mockClear();
      emitGatewayEvent(state, "chat", terminal);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("recovers a terminal failure once without retrying a missing receipt", async () => {
    vi.useFakeTimers();
    try {
      const runId = "failed-run";
      const request = vi.fn().mockResolvedValue({
        ...createTerminalHistory([]),
        sessionInfo: {
          ...createTerminalHistory([]).sessionInfo,
          status: "failed",
          lastRunId: runId,
          lastRunError: "Storage is unavailable",
        },
      });
      const { state } = createSessionEventState({
        chatRunId: runId,
        pendingSessionMessageReloadSessionKey: null,
        client: createTestGatewayClient(withAuthStatus(request)),
      });
      const fail = event(
        state,
        { runId, state: "error", errorMessage: "Storage is unavailable" },
        false,
      );
      fail();
      await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
      expect(state.chatRunError).toMatchObject({ runId, summary: "Error: Storage is unavailable" });
      fail();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["other session", "background run"])(
    "does not recover failure history for %s",
    (kind) => {
      const request = vi.fn();
      const { state } = createSessionEventState({
        chatRunId: "foreground-run",
        client: createTestGatewayClient(withAuthStatus(request)),
      });
      event(
        state,
        {
          sessionKey: kind === "other session" ? "agent:main:other" : state.sessionKey,
          runId: kind === "background run" ? "background-run" : "foreground-run",
          state: "error",
          errorMessage: "Another request failed",
        },
        false,
      )();
      expect(request).not.toHaveBeenCalled();
      expect(state.chatRunId).toBe("foreground-run");
    },
  );

  it("recovers once when history completed the run before its message-less terminal arrives", async () => {
    const runId = "run-completed-by-history-before-terminal";
    const { persistedReply, request, state } = fixture(
      runId,
      "Finish after the tool call",
      assistant("The durable final arrived after the snapshot.").content,
    );
    reduceChatSessionProjection(state, { type: "runTerminal", runId, status: "completed" });

    const finish = event(state, { runId, state: "final" });
    finish();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(state.chatMessages).toContainEqual(persistedReply));

    request.mockClear();
    finish();
    expect(request).not.toHaveBeenCalled();
  });

  it("recovers durable media from a message-less terminal", async () => {
    vi.useFakeTimers();
    try {
      const runId = "run-with-message-less-terminal";
      const { persistedReply, request, state } = fixture(
        runId,
        "Show the generated image",
        [{ type: "image", url: "data:image/png;base64,aW1hZ2U=" }],
        {},
        true,
      );
      const terminal = { sessionKey: state.sessionKey, runId, state: "final" };
      emitGatewayEvent(state, "chat", terminal);
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(1);
      expect(state.chatMessages).toContainEqual(persistedReply);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    { name: "without a pending session-message reload", pendingReload: false },
    { name: "after a pending session-message reload", pendingReload: true },
  ])("waits for the old read before fresh terminal history $name", async ({ pendingReload }) => {
    const runId = "run-with-pre-final-history";
    const staleHistory = createDeferred<ChatHistoryResult>();
    const freshHistory = createDeferred<ChatHistoryResult>();
    const freshHistoryStarted = createDeferred();
    const request = vi
      .fn()
      .mockReturnValueOnce(staleHistory.promise)
      .mockImplementationOnce(() => {
        freshHistoryStarted.resolve();
        return freshHistory.promise;
      });
    const { prompt, persistedReply, state } = fixture(
      runId,
      "Finish after the stale snapshot",
      assistant("The post-final snapshot contains this reply.").content,
      {
        pendingSessionMessageReloadSessionKey: pendingReload ? "agent:main:main" : null,
        client: { request: withAuthStatus(request) } as unknown as GatewayBrowserClient,
      },
    );

    const preFinalLoad = loadChatHistory(state);
    expect(request).toHaveBeenCalledTimes(1);

    emitGatewayEvent(state, "chat", {
      sessionKey: state.sessionKey,
      runId,
      state: "final",
    });

    expect(request).toHaveBeenCalledTimes(1);
    staleHistory.resolve(createTerminalHistory([prompt]));
    await freshHistoryStarted.promise;
    expect(request).toHaveBeenCalledTimes(2);
    expect(renderedTranscript(state)).toEqual(
      transcript(["user", "Finish after the stale snapshot"]),
    );

    freshHistory.resolve(createTerminalHistory([prompt, persistedReply]));
    await preFinalLoad;
    expect(state.chatLoading).toBe(false);
    expect(renderedTranscript(state)).toEqual(
      transcript(
        ["user", "Finish after the stale snapshot"],
        ["assistant", "The post-final snapshot contains this reply."],
      ),
    );
  });

  it.each([
    "background",
    "yielded",
    "live reply",
    "retired background",
    "retired yielded",
    "retired other session",
    "aborted",
  ])("does not recover history for a %s terminal", (kind) => {
    const runId = "foreground-run";
    const prompt = createRecoveryPrompt(runId, "Finish the dashboard task");
    const request = vi.fn();
    const { state } = createSessionEventState({
      chatRunId: runId,
      ...(kind === "background"
        ? {
            chatStream: "The foreground reply is still streaming.",
            chatStreamStartedAt: 123,
          }
        : kind === "live reply"
          ? { chatMessages: [prompt] }
          : {}),
      client: createTestGatewayClient(withAuthStatus(request)),
    });
    emitGatewayEvent(state, "chat", {
      sessionKey: state.sessionKey,
      runId: kind.endsWith("background") ? "background-run" : runId,
      state: kind === "aborted" ? "aborted" : "final",
      ...(kind.endsWith("yielded") ? { yielded: true, stopReason: "end_turn" } : {}),
      ...(kind === "retired other session" ? { sessionKey: "agent:main:other" } : {}),
      ...(kind.startsWith("retired") || kind === "aborted"
        ? {
            message: retired("Already retired"),
          }
        : {}),
      ...(kind === "live reply"
        ? {
            message: assistant("The live reply is already projected."),
          }
        : {}),
    });
    expect(request).not.toHaveBeenCalled();
    if (kind === "background") {
      expect(state.chatRunId).toBe(runId);
      expect(state.chatStream).toBe("The foreground reply is still streaming.");
      expect(state.chatStreamStartedAt).toBe(123);
    } else if (kind === "live reply") {
      expect(state.chatRunId).toBeNull();
      expect(renderedTranscript(state)).toEqual(
        transcript(
          ["user", "Finish the dashboard task"],
          ["assistant", "The live reply is already projected."],
        ),
      );
    }
  });
});
