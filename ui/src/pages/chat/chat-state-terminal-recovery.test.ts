import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createSessionEventState, renderedTranscript } from "./chat-state.test-support.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "./history-merge.ts";

const historyBudget = { limit: 80, maxBytes: 256 * 1024, toolResultMaxChars: 2_000 };

function emitGatewayEvent(
  state: ChatPageHost,
  event: Parameters<typeof handlePageGatewayEvent>[1]["event"],
  payload: Parameters<typeof handlePageGatewayEvent>[1]["payload"],
) {
  handlePageGatewayEvent(state, { type: "event", event, payload });
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
        kind: sessionKey === "global" ? "global" : "direct",
        updatedAt: 2,
        hasActiveRun: false,
        activeRunIds: [],
        status: "done",
      },
    };
  }

  it.each([
    { name: "omitted", terminalMessage: undefined, startsActive: true },
    { name: "null", terminalMessage: null, startsActive: true },
    {
      name: "retired display content for an idle selected session",
      terminalMessage: {
        role: "assistant",
        content: [{ type: "text", text: "Saved reply" }],
        openclawDisplayContent: [],
      },
      startsActive: false,
    },
    {
      name: "retired display content",
      terminalMessage: {
        role: "assistant",
        content: [{ type: "text", text: "The durable reply must appear below Done." }],
        openclawDisplayContent: [],
      },
      startsActive: true,
    },
    {
      name: "omitted for an idle selected session",
      terminalMessage: undefined,
      startsActive: false,
    },
  ])(
    "recovers the durable reply when the terminal message is $name",
    async ({ terminalMessage, startsActive }) => {
      const runId = "run-with-message-less-terminal";
      const replyText = "The durable reply must appear below Done.";
      const prompt = createRecoveryPrompt(runId, "Finish the dashboard task");
      const persistedReply = {
        role: "assistant",
        content: [{ type: "text", text: replyText }],
        stopReason: "stop",
        __openclaw: { id: "reply-1", runId, seq: 2 },
      };
      const request = vi.fn().mockResolvedValue(createTerminalHistory([prompt, persistedReply]));
      const { state } = createSessionEventState({
        chatMessages: [prompt],
        chatHistoryPagination: { hasMore: false },
        chatRunId: startsActive ? runId : null,

        pendingSessionMessageReloadSessionKey: null,
        client: { request } as unknown as GatewayBrowserClient,
      });

      emitGatewayEvent(state, "chat", {
        sessionKey: state.sessionKey,
        runId,
        state: "final",
        message: terminalMessage,
      });

      expect(state.chatRunId).toBeNull();
      expect(renderedTranscript(state)).toEqual([
        { role: "user", text: "Finish the dashboard task" },
      ]);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "chat.history",
          {
            sessionKey: state.sessionKey,
            ...historyBudget,
          },
          { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
        ),
      );
      await vi.waitFor(() => expect(state.chatLoading).toBe(false));
      expect(request).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(renderedTranscript(state)).toEqual([
          { role: "user", text: "Finish the dashboard task" },
          { role: "assistant", text: replyText },
        ]),
      );

      request.mockClear();
      emitGatewayEvent(state, "chat", {
        sessionKey: state.sessionKey,
        runId,
        state: "final",
        message: terminalMessage,
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("recovers a terminal failure once without retrying a missing receipt", async () => {
    vi.useFakeTimers();
    try {
      const runId = "failed-run";
      const request = vi.fn().mockResolvedValue({
        messages: [],
        sessionId: "selected-session",
        sessionInfo: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 2,
          status: "failed",
          hasActiveRun: false,
          activeRunIds: [],
          lastRunId: runId,
          lastRunError: "Storage is unavailable",
        },
      });
      const { state } = createSessionEventState({
        chatRunId: runId,
        pendingSessionMessageReloadSessionKey: null,
        client: createTestGatewayClient(request),
      });
      const event = {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: state.sessionKey,
          runId,
          state: "error",
          errorMessage: "Storage is unavailable",
        },
      } satisfies Parameters<typeof handlePageGatewayEvent>[1];
      handlePageGatewayEvent(state, event, () => false);
      await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
      expect(state.chatRunError).toMatchObject({ runId, summary: "Error: Storage is unavailable" });
      handlePageGatewayEvent(state, event, () => false);
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
        client: createTestGatewayClient(request),
      });
      handlePageGatewayEvent(
        state,
        {
          type: "event",
          event: "chat",
          payload: {
            sessionKey: kind === "other session" ? "agent:main:other" : state.sessionKey,
            runId: kind === "background run" ? "background-run" : "foreground-run",
            state: "error",
            errorMessage: "Another request failed",
          },
        },
        () => false,
      );
      expect(request).not.toHaveBeenCalled();
      expect(state.chatRunId).toBe("foreground-run");
    },
  );

  it("recovers once when history completed the run before its message-less terminal arrives", async () => {
    const runId = "run-completed-by-history-before-terminal";
    const prompt = createRecoveryPrompt(runId, "Finish after the tool call");
    const persistedReply = {
      role: "assistant",
      content: [{ type: "text", text: "The durable final arrived after the snapshot." }],
      stopReason: "stop",
      __openclaw: { id: "reply-1", runId, seq: 2 },
    };
    const request = vi.fn().mockResolvedValue(createTerminalHistory([prompt, persistedReply]));
    const { state } = createSessionEventState({
      chatMessages: [prompt],
      chatHistoryPagination: { hasMore: false },
      chatRunId: runId,
      client: { request } as unknown as GatewayBrowserClient,
    });
    reduceChatSessionProjection(state, { type: "runTerminal", runId, status: "completed" });

    const terminalEvent = {
      type: "event",
      event: "chat",
      payload: { sessionKey: state.sessionKey, runId, state: "final" },
    } satisfies Parameters<typeof handlePageGatewayEvent>[1];
    handlePageGatewayEvent(state, terminalEvent);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(state.chatMessages).toContainEqual(persistedReply));

    request.mockClear();
    handlePageGatewayEvent(state, terminalEvent);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([true, false])("bounds terminal recovery with durable media=%s", async (durable) => {
    vi.useFakeTimers();
    try {
      const runId = "run-with-message-less-terminal";
      const promptText = durable ? "Show the generated image" : "Finish without persisting a reply";
      const prompt = createRecoveryPrompt(runId, promptText);
      const persistedReply = {
        role: "assistant",
        content: [{ type: "image", url: "data:image/png;base64,aW1hZ2U=" }],
        stopReason: "stop",
        __openclaw: { id: "reply-1", runId, seq: 2 },
      };
      const request = vi
        .fn()
        .mockResolvedValue(createTerminalHistory(durable ? [prompt, persistedReply] : [prompt]));
      const { state } = createSessionEventState({
        chatMessages: [prompt],
        chatHistoryPagination: { hasMore: false },
        chatRunId: runId,
        client: createTestGatewayClient(request),
      });
      const terminal = { sessionKey: state.sessionKey, runId, state: "final" };
      emitGatewayEvent(state, "chat", terminal);
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(durable ? 1 : 5);
      if (durable) {
        expect(state.chatMessages).toContainEqual(persistedReply);
      } else {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(request).toHaveBeenCalledTimes(5);
        expect(renderedTranscript(state)).toEqual([{ role: "user", text: promptText }]);
        emitGatewayEvent(state, "chat", terminal);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(request).toHaveBeenCalledTimes(5);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["session", "global agent", "replacement starts", "replacement finishes"])(
    "retires terminal recovery when its owner changes: %s",
    async (transition) => {
      vi.useFakeTimers();
      try {
        const runId = "run-before-replacement";
        const replacementRunId = "replacement-run";
        const sessionKey = transition === "global agent" ? "global" : "agent:main:main";
        const prompt = createRecoveryPrompt(runId, "Finish before ownership changes");
        const request = vi.fn().mockResolvedValue(createTerminalHistory([prompt], sessionKey));
        const { state } = createSessionEventState({
          sessionKey,
          ...(transition === "global agent"
            ? {
                assistantAgentId: "main",
                agentsSelectedId: "main",
                agentsList: {
                  defaultId: "main",
                  mainKey: "main",
                  scope: "global",
                  agents: [{ id: "main" }, { id: "work" }],
                },
              }
            : {}),
          chatMessages: [prompt],
          chatHistoryPagination: { hasMore: false },
          chatRunId: runId,
          client: createTestGatewayClient(request),
        });
        emitGatewayEvent(state, "chat", {
          sessionKey,
          runId,
          state: "final",
          ...(transition === "global agent" ? { agentId: "main" } : {}),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledTimes(1);
        if (transition === "global agent") {
          expect(request).toHaveBeenLastCalledWith(
            "chat.history",
            expect.objectContaining({ sessionKey: "global", agentId: "main" }),
            { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
          );
          state.assistantAgentId = "work";
          state.agentsSelectedId = "work";
        } else if (transition === "session") {
          state.sessionKey = "agent:main:replacement";
        } else {
          state.chatRunId = replacementRunId;
          if (transition === "replacement finishes") {
            emitGatewayEvent(state, "chat", {
              sessionKey,
              runId: replacementRunId,
              state: "final",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Replacement finished." }],
                __openclaw: { id: "replacement-reply", runId: replacementRunId, seq: 2 },
              },
            });
            expect(state.chatRunId).toBeNull();
            expect(getChatSessionProjection(state).runs[replacementRunId]?.status).toBe(
              "completed",
            );
          }
        }
        await vi.advanceTimersByTimeAsync(100);
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["another-run", "nested-tool-only"] as const)(
    "continues terminal recovery when history backfills %s",
    async (historyKind) => {
      vi.useFakeTimers();
      try {
        const runId = "run-after-history-backfill";
        const historicalRunId = "older-run-from-history";
        const prompt = createRecoveryPrompt(runId, "Finish after loading older history", 2);
        const historicalReply = {
          role: "assistant",
          content: [{ type: "text", text: "An older durable reply." }],
          __openclaw: { id: "historical-reply", runId: historicalRunId, seq: 1 },
        };
        // Public history projects tool blocks, not the stored empty-content activity fact.
        const nestedActivity = {
          role: "custom",
          customType: "openclaw.nested-tool.v1",
          display: true,
          excludeFromContext: true,
          runId,
          timestamp: 2,
          content: [
            {
              type: "toolCall",
              id: "nested-read",
              runId,
              name: "read",
              arguments: { path: "note.txt" },
              parentToolCallId: "outer-exec",
              timestamp: 2,
            },
            {
              type: "toolResult",
              role: "toolResult",
              runId,
              scopeId: "attempt-1",
              afterEntryId: "prompt-1",
              startOrder: 0,
              parentToolCallId: "outer-exec",
              toolCallId: "nested-read",
              toolName: "read",
              isError: false,
              startedAt: 2,
              timestamp: 3,
              content: [{ type: "text", text: "Nested read completed." }],
            },
          ],
          __openclaw: { id: "nested-activity-1", seq: 3 },
        };
        const precedingRow = historyKind === "another-run" ? historicalReply : nestedActivity;
        const beforeFinal =
          historyKind === "another-run" ? [historicalReply, prompt] : [prompt, nestedActivity];
        const replyText = "The current reply is now durable.";
        const persistedReply = {
          role: "assistant",
          content: [{ type: "text", text: replyText }],
          stopReason: "stop",
          __openclaw: { id: "current-reply", runId, seq: historyKind === "another-run" ? 3 : 4 },
        };
        const sessionInfo = {
          key: "agent:main:main",
          kind: "direct" as const,
          updatedAt: 3,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done" as const,
        };
        const request = vi
          .fn()
          .mockResolvedValueOnce({
            messages: beforeFinal,
            sessionId: "selected-session",
            sessionInfo,
          })
          .mockResolvedValueOnce({
            messages: [...beforeFinal, persistedReply],
            sessionId: "selected-session",
            sessionInfo,
          });
        const { state } = createSessionEventState({
          chatMessages: [prompt],
          chatHistoryPagination: { hasMore: false },
          chatRunId: runId,
          client: { request } as unknown as GatewayBrowserClient,
        });

        emitGatewayEvent(state, "chat", { sessionKey: state.sessionKey, runId, state: "final" });

        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledTimes(1);
        expect(state.chatMessages).toContainEqual(precedingRow);
        expect(state.chatMessages).not.toContainEqual(persistedReply);
        await vi.advanceTimersByTimeAsync(100);
        expect(request).toHaveBeenCalledTimes(2);
        expect(state.chatMessages.filter((message) => extractText(message) === replyText)).toEqual([
          persistedReply,
        ]);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { name: "without a pending session-message reload", pendingReload: false },
    { name: "after a pending session-message reload", pendingReload: true },
  ])("waits for the old read before fresh terminal history $name", async ({ pendingReload }) => {
    const runId = "run-with-pre-final-history";
    const prompt = createRecoveryPrompt(runId, "Finish after the stale snapshot");
    const persistedReply = {
      role: "assistant",
      content: [{ type: "text", text: "The post-final snapshot contains this reply." }],
      stopReason: "stop",
      __openclaw: { id: "reply-1", runId, seq: 2 },
    };
    const staleHistory = createDeferred<ChatHistoryResult>();
    const freshHistory = createDeferred<ChatHistoryResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(staleHistory.promise)
      .mockReturnValueOnce(freshHistory.promise);
    const { state } = createSessionEventState({
      chatMessages: [prompt],
      chatHistoryPagination: { hasMore: false },
      chatRunId: runId,

      pendingSessionMessageReloadSessionKey: pendingReload ? "agent:main:main" : null,
      client: { request } as unknown as GatewayBrowserClient,
    });
    const sessionInfo = {
      key: state.sessionKey,
      kind: "direct" as const,
      updatedAt: 2,
      hasActiveRun: false,
      activeRunIds: [],
      status: "done" as const,
    };

    const preFinalLoad = loadChatHistory(state);
    expect(request).toHaveBeenCalledTimes(1);

    emitGatewayEvent(state, "chat", {
      sessionKey: state.sessionKey,
      runId,
      state: "final",
    });

    expect(request).toHaveBeenCalledTimes(1);
    staleHistory.resolve({ messages: [prompt], sessionId: "selected-session", sessionInfo });
    await preFinalLoad;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(renderedTranscript(state)).toEqual([
      { role: "user", text: "Finish after the stale snapshot" },
    ]);

    freshHistory.resolve({
      messages: [prompt, persistedReply],
      sessionId: "selected-session",
      sessionInfo,
    });
    await vi.waitFor(() => expect(state.chatLoading).toBe(false));
    expect(renderedTranscript(state)).toEqual([
      { role: "user", text: "Finish after the stale snapshot" },
      { role: "assistant", text: "The post-final snapshot contains this reply." },
    ]);
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
      client: createTestGatewayClient(request),
    });
    emitGatewayEvent(state, "chat", {
      sessionKey: state.sessionKey,
      runId: kind.endsWith("background") ? "background-run" : runId,
      state: kind === "aborted" ? "aborted" : "final",
      ...(kind.endsWith("yielded") ? { yielded: true, stopReason: "end_turn" } : {}),
      ...(kind === "retired other session" ? { sessionKey: "agent:main:other" } : {}),
      ...(kind.startsWith("retired") || kind === "aborted"
        ? {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Already retired" }],
              openclawDisplayContent: [],
            },
          }
        : {}),
      ...(kind === "live reply"
        ? {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "The live reply is already projected." }],
            },
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
      expect(renderedTranscript(state)).toEqual([
        { role: "user", text: "Finish the dashboard task" },
        { role: "assistant", text: "The live reply is already projected." },
      ]);
    }
  });
});
