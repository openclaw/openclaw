import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionBranch } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

describe("chat branch freshness", () => {
  function createSessionEventState(overrides: Partial<ChatPageHost> = {}) {
    const request = vi.fn().mockResolvedValue({
      messages: [],
      sessionId: "selected-session",
      thinkingLevel: null,
    });
    const requestUpdate = overrides.requestUpdate ?? vi.fn();
    const host = makeChatHost({
      client: createTestGatewayClient(request),
      connectionEpoch: 1,
      sessionKey: "agent:main:main",
      ...overrides,
    });
    if (!overrides.sessions) {
      vi.spyOn(host.sessions, "refresh").mockResolvedValue(undefined);
      vi.spyOn(host.sessions, "listBranches").mockResolvedValue([]);
    }
    const state = {
      ...host,
      currentSessionId: "selected-session",
      chatMessagesBySession: new Map(),
      chatThinkingLevel: null,
      chatVerboseLevel: null,
      chatStreamStartedAt: null,
      renderLifecycle: { invalidate: requestUpdate },
      requestUpdate,
      ...overrides,
    } as unknown as ChatPageHost;
    return { request, state };
  }

  it.each(["assistant", "toolResult"])(
    "refreshes preserved branches after a persisted %s message without reloading the page",
    async (role) => {
      const original = {
        leafEntryId: "original-reply",
        headline: "Original reply",
        messageCount: 2,
        active: false,
      };
      const replacement = {
        leafEntryId: "replacement-reply",
        headline: "Replacement reply",
        messageCount: 2,
        active: true,
      };
      const { state } = createSessionEventState({
        chatBranches: [original],
        chatBranchesSessionKey: "agent:main:main",
        chatBranchesConnectionEpoch: 1,
      });
      const listBranches = vi
        .mocked(state.sessions.listBranches)
        .mockResolvedValue([replacement, original]);
      // Ordinary history reads and streamed text do not change the persisted graph.
      await loadChatHistory(state);
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: state.sessionKey,
          runId: "replacement-run",
          state: "delta",
          deltaText: "Replacement",
          message: { role: "assistant", content: [{ type: "text", text: "Replacement" }] },
        },
      });
      expect(state.chatStream).toBe("Replacement");
      expect(listBranches).not.toHaveBeenCalled();
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: state.sessionKey,
          runId: "replacement-run",
          state: role === "toolResult" ? "aborted" : "final",
          message: { role: "assistant", content: "Replacement reply" },
        },
      });
      handlePageGatewayEvent(state, {
        type: "event",
        event: "session.message",
        payload: {
          sessionKey: state.sessionKey,
          hasActiveRun: false,
          messageId: "replacement-reply",
          messageSeq: 4,
          message: { role, content: "Replacement reply" },
        },
      });
      await vi.waitFor(() => expect(state.chatBranches).toEqual([replacement, original]));
      const reads = listBranches.mock.calls.length;
      await loadChatHistory(state);
      expect(listBranches).toHaveBeenCalledTimes(reads);
    },
  );

  it("refreshes branches after an append races an in-flight history read", async () => {
    const original = {
      leafEntryId: "original",
      headline: "Original reply",
      messageCount: 2,
      active: false,
    };
    const replacement = { ...original, leafEntryId: "replacement", active: true };
    const { request, state } = createSessionEventState({
      chatBranches: [original],
      chatBranchesSessionKey: "agent:main:main",
      chatBranchesConnectionEpoch: 1,
    });
    const history = createDeferred<{ messages: []; sessionId: string }>();
    request.mockReturnValueOnce(history.promise);
    vi.mocked(state.sessions.listBranches).mockResolvedValue([replacement, original]);
    const pending = loadChatHistory(state);
    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        hasActiveRun: false,
        messageId: "replacement",
        messageSeq: 4,
        message: { role: "assistant", content: "Replacement reply" },
      },
    });
    history.resolve({ messages: [], sessionId: "selected-session" });
    await pending;
    await vi.waitFor(() => expect(state.chatBranches).toEqual([replacement, original]));
  });

  it("retires a pre-append branch read and defers hidden-pane refresh until presentation", async () => {
    const original = {
      leafEntryId: "original-reply",
      headline: "Original reply",
      messageCount: 2,
      active: false,
    };
    const replacement = { ...original, leafEntryId: "replacement", active: true };
    const { state } = createSessionEventState({
      chatBranches: [original],
      chatBranchesSessionKey: "agent:main:main",
      chatBranchesConnectionEpoch: 1,
    });
    const stale = createDeferred<SessionBranch[]>();
    const listBranches = vi
      .mocked(state.sessions.listBranches)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue([replacement, original]);
    const pending = loadChatBranches(state);
    handlePageGatewayEvent(
      state,
      {
        type: "event",
        event: "session.message",
        payload: {
          sessionKey: state.sessionKey,
          hasActiveRun: false,
          messageId: "replacement",
          messageSeq: 3,
          message: { role: "user", content: "Replacement prompt" },
        },
      },
      () => false,
    );
    stale.resolve([original]);
    await pending;
    await loadChatHistory(state, { deferBranches: true });
    expect(listBranches).toHaveBeenCalledOnce();
    expect(state.chatBranches).toEqual([original]);
    expect(state.chatBranchesConnectionEpoch).toBeNull();
    // Retained-pane presentation reloads summaries with an invalidated epoch.
    await loadChatBranches(state);
    expect(state.chatBranches).toEqual([replacement, original]);
    expect(listBranches).toHaveBeenCalledTimes(2);
  });
});
