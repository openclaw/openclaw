// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { getChatSessionProjection } from "./history-merge.ts";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each([false, true])(
  "presents a late host failure without relabeling execution (newer=%s)",
  (newer) => {
    vi.useFakeTimers();
    const runId = "waiting-reply-run";
    const state: ChatState = {
      chatAttachments: [],
      chatHistoryPagination: { hasMore: false },
      chatLoading: false,
      chatMessage: "",
      chatMessages: [],
      chatQueue: [],
      chatRunId: runId,
      chatSending: false,
      chatStream: null,
      chatStreamStartedAt: null,
      chatRunStartup: null,
      chatThinkingLevel: null,
      chatVerboseLevel: null,
      client: null,
      connected: true,
      connectionEpoch: 0,
      hello: null,
      lastError: null,
      sessionKey: "main",
    };
    handleChatGatewayEvent(state, { sessionKey: "main", runId, seq: 1, state: "final" });
    if (newer) {
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "newer-run",
        seq: 1,
        state: "delta",
        deltaText: "New work",
      });
    }
    const diagnostic = {
      sessionKey: "main",
      runId,
      seq: 2,
      state: "error" as const,
      errorMessage: "Waiting reply transcript append failed: storage unavailable",
    };
    handleChatGatewayEvent(state, diagnostic);
    expect(getChatSessionProjection(state).runs[runId]).toMatchObject({
      status: "completed",
      errorMessage: diagnostic.errorMessage,
    });
    expect(state.chatRunError).toEqual(
      newer
        ? null
        : {
            runId,
            summary: "Error: " + diagnostic.errorMessage,
          },
    );
    const displayed = state.chatRunError;
    handleChatGatewayEvent(state, diagnostic);
    expect(state.chatRunError).toBe(displayed);
    expect(state.chatRunId).toBe(newer ? "newer-run" : null);
  },
);
