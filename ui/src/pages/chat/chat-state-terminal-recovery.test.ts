import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
import { createSessionEventState, renderedTranscript } from "./chat-state.test-support.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";

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

function fakeTimers() {
  vi.useFakeTimers();
  onTestFinished(() => vi.useRealTimers());
}

function recoveryState(request: GatewayRequestHandler, overrides: Partial<ChatPageHost> = {}) {
  return createSessionEventState({
    client: createTestGatewayClient(withAuthStatus(request)),
    ...overrides,
  }).state;
}

describe("terminal reply recovery", () => {
  const runId = "run-1";
  const promptText = "Finish the task";
  const replyText = "The durable reply";
  function createRecoveryPrompt() {
    return {
      role: "user",
      content: [{ type: "text", text: promptText }],
      __openclaw: { id: "prompt-1", idempotencyKey: `${runId}:user`, seq: 1 },
    };
  }

  function createTerminalHistory(messages: unknown[]) {
    return {
      messages,
      sessionId: "selected-session",
      sessionInfo: {
        key: "agent:main:main",
        kind: "direct" as const,
        updatedAt: 2,
        hasActiveRun: false,
        activeRunIds: [],
        status: "done" as const,
      },
    };
  }

  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
  const retired = (text: string) => ({ ...assistant(text), openclawDisplayContent: [] });
  const transcript = (...turns: [role: string, text: string][]) =>
    turns.map(([role, text]) => ({ role, text }));
  const expectTranscript = (state: ChatPageHost, ...turns: [role: string, text: string][]) =>
    expect(renderedTranscript(state)).toEqual(transcript(...turns));
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
    overrides: Partial<ChatPageHost> = {},
    replyContent: unknown = assistant(replyText).content,
    authenticated = false,
  ) {
    const prompt = createRecoveryPrompt();
    const persistedReply = {
      role: "assistant",
      content: replyContent,
      stopReason: "stop",
      __openclaw: { id: "reply-1", runId, seq: 2 },
    };
    const request = vi.fn().mockResolvedValue(createTerminalHistory([prompt, persistedReply]));
    const state = recoveryState(request, {
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
    ["completed by history", undefined, true, true],
  ] as const)(
    "recovers the durable reply when the terminal message is %s",
    async (_name, terminalMessage, startsActive, completedByHistory = false) => {
      const { request, state, persistedReply } = fixture({
        chatRunId: startsActive ? runId : null,
      });
      if (completedByHistory) {
        reduceChatSessionProjection(state, { type: "runTerminal", runId, status: "completed" });
      }
      const finish = event(state, { runId, state: "final", message: terminalMessage });
      finish();

      expect(state.chatRunId).toBeNull();
      expectTranscript(state, ["user", promptText]);
      await vi.waitFor(() =>
        expectTranscript(state, ["user", promptText], ["assistant", replyText]),
      );
      expect(state.chatLoading).toBe(false);
      expect(state.chatMessages).toContainEqual(persistedReply);
      expect(request).toHaveBeenCalledTimes(1);

      request.mockClear();
      finish();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("recovers a terminal failure once without retrying a missing receipt", async () => {
    fakeTimers();
    const request = vi.fn().mockResolvedValue({
      ...createTerminalHistory([]),
      sessionInfo: {
        ...createTerminalHistory([]).sessionInfo,
        status: "failed",
        lastRunId: runId,
        lastRunError: "Storage is unavailable",
      },
    });
    const state = recoveryState(request, {
      chatRunId: runId,
      pendingSessionMessageReloadSessionKey: null,
    });
    const historyCalls = () => request.mock.calls.filter(([method]) => method === "chat.history");
    const fail = event(
      state,
      { runId, state: "error", errorMessage: "Storage is unavailable" },
      false,
    );
    fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(historyCalls()).toHaveLength(1);
    expect(state.chatRunError).toMatchObject({ runId, summary: "Error: Storage is unavailable" });
    fail();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(historyCalls()).toHaveLength(1);
  });

  it("recovers durable media from a message-less terminal", async () => {
    fakeTimers();
    const { persistedReply, request, state } = fixture(
      {},
      [{ type: "image", url: "data:image/png;base64,aW1hZ2U=" }],
      true,
    );
    event(state, { runId, state: "final" })();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatMessages).toContainEqual(persistedReply);
  });
  it.each([false, true])(
    "waits for the old read before fresh terminal history (pending=%s)",
    async (pendingReload) => {
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
      const { prompt, persistedReply, state } = fixture({
        pendingSessionMessageReloadSessionKey: pendingReload ? "agent:main:main" : null,
        client: { request: withAuthStatus(request) } as unknown as GatewayBrowserClient,
      });

      const preFinalLoad = loadChatHistory(state);
      expect(request).toHaveBeenCalledTimes(1);

      event(state, { runId, state: "final" })();

      expect(request).toHaveBeenCalledTimes(1);
      staleHistory.resolve(createTerminalHistory([prompt]));
      await freshHistoryStarted.promise;
      expect(request).toHaveBeenCalledTimes(2);
      expectTranscript(state, ["user", promptText]);

      freshHistory.resolve(createTerminalHistory([prompt, persistedReply]));
      await preFinalLoad;
      expect(state.chatLoading).toBe(false);
      expectTranscript(state, ["user", promptText], ["assistant", replyText]);
    },
  );

  it.each([
    ["background", { runId: "background-run" }],
    ["yielded", { yielded: true, stopReason: "end_turn" }],
    ["live reply", { message: assistant("Live reply") }],
    ["retired background", { runId: "background-run", message: retired("Retired") }],
    ["retired yielded", { yielded: true, stopReason: "end_turn", message: retired("Retired") }],
    ["retired other session", { sessionKey: "agent:main:other", message: retired("Retired") }],
    ["aborted", { state: "aborted", message: retired("Retired") }],
    [
      "other session failure",
      { sessionKey: "agent:main:other", state: "error", errorMessage: "Failed" },
    ],
    ["background failure", { runId: "background-run", state: "error", errorMessage: "Failed" }],
  ] as const)("does not recover history for a %s terminal", (kind, payload) => {
    const prompt = createRecoveryPrompt();
    const request = vi.fn();
    const streaming = { chatStream: "Streaming", chatStreamStartedAt: 123 };
    const state = recoveryState(request, {
      chatRunId: runId,
      ...(kind === "background" ? streaming : {}),
      ...(kind === "live reply" ? { chatMessages: [prompt] } : {}),
    });
    const failure = "state" in payload && payload.state === "error";
    event(state, { runId, state: "final", ...payload }, !failure)();
    expect(request).not.toHaveBeenCalled();
    if (failure) {
      expect(state.chatRunId).toBe(runId);
    }
    if (kind === "background") {
      expect(state).toMatchObject({ chatRunId: runId, ...streaming });
    } else if (kind === "live reply") {
      expect(state.chatRunId).toBeNull();
      expectTranscript(state, ["user", promptText], ["assistant", "Live reply"]);
    }
  });
});
