import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionBranch } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  invalidateChatBranches,
  loadChatBranches,
  retireChatBranchRequests,
} from "./chat-history-branches.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

describe("chat branch freshness", () => {
  it.each([
    ["invalidation", invalidateChatBranches],
    ["retirement", retireChatBranchRequests],
  ] as const)("shares an initial branch read until %s retires it", async (_reason, retire) => {
    const first = createDeferred<{ branches: SessionBranch[] }>();
    const replacement = createDeferred<{ branches: SessionBranch[] }>();
    const listBranches = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(replacement.promise);
    const state = makeChatHost({
      sessionKey: "agent:main:main",
      connectionEpoch: 1,
      requestHandlers: { "sessions.branches.list": listBranches },
    });
    const initial = loadChatBranches(state);
    const joined = loadChatBranches(state);
    expect(listBranches).toHaveBeenCalledOnce();

    retire(state);
    const refreshed = loadChatBranches(state);
    const refreshedJoin = loadChatBranches(state);
    expect(listBranches).toHaveBeenCalledTimes(2);
    const current = {
      leafEntryId: "current",
      headline: "Current reply",
      messageCount: 2,
      active: true,
    };
    replacement.resolve({ branches: [current] });
    await Promise.all([refreshed, refreshedJoin]);
    first.resolve({ branches: [] });
    await Promise.all([initial, joined]);
    expect(state.chatBranches).toEqual([current]);
    expect(state.chatBranchesConnectionEpoch).toBe(1);
    expect(state.chatBranchesSessionKey).toBe("agent:main:main");
  });

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

  it.each([
    { role: "assistant", historyPending: false },
    { role: "toolResult", historyPending: false },
    { role: "assistant", historyPending: true },
  ])(
    "refreshes branches after persisted $role (history pending: $historyPending)",
    async ({ role, historyPending }) => {
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
      const { request, state } = createSessionEventState({
        chatBranches: [original],
        chatBranchesSessionKey: "agent:main:main",
        chatBranchesConnectionEpoch: 1,
      });
      const listBranches = vi
        .mocked(state.sessions.listBranches)
        .mockResolvedValue([replacement, original]);
      const history = createDeferred<{ messages: []; sessionId: string }>();
      let pending: ReturnType<typeof loadChatHistory> | undefined;
      if (historyPending) {
        request.mockReturnValueOnce(history.promise);
        pending = loadChatHistory(state);
      } else {
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
      }
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
      if (historyPending) {
        history.resolve({ messages: [], sessionId: "selected-session" });
        await pending;
      }
      await vi.waitFor(() => expect(state.chatBranches).toEqual([replacement, original]));
      const reads = listBranches.mock.calls.length;
      await loadChatHistory(state);
      expect(listBranches).toHaveBeenCalledTimes(reads);
    },
  );

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
