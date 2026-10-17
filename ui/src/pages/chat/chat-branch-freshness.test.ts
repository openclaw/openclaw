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

function branch(leafEntryId = "original-reply", active = false): SessionBranch {
  return { leafEntryId, headline: "Original reply", messageCount: 2, active };
}

function withBranches(chatBranches: SessionBranch[]) {
  return {
    chatBranches,
    chatBranchesSessionKey: "agent:main:main",
    chatBranchesConnectionEpoch: 1,
  };
}

function chatEvent(state: ChatPageHost, payload: Record<string, unknown>) {
  handlePageGatewayEvent(state, {
    type: "event",
    event: "chat",
    payload: { sessionKey: state.sessionKey, runId: "replacement-run", ...payload },
  });
}

function persistedMessage(
  state: ChatPageHost,
  role: string,
  messageId = "replacement-reply",
  messageSeq = 4,
  presented?: () => boolean,
) {
  handlePageGatewayEvent(
    state,
    {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        hasActiveRun: false,
        messageId,
        messageSeq,
        message: { role, content: role === "user" ? "Replacement prompt" : "Replacement reply" },
      },
    },
    presented,
  );
}

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
    const current = { ...branch("current", true), headline: "Current reply" };
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

  it("keeps unchanged empty branch reads idle while recording their freshness", async () => {
    const requestUpdate = vi.fn();
    const { state } = createSessionEventState({ requestUpdate });
    await loadChatBranches(state);
    expect(state.chatBranches).toEqual([]);
    expect(state.chatBranchesSessionKey).toBe(state.sessionKey);
    expect(state.chatBranchesConnectionEpoch).toBe(state.connectionEpoch);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("keeps unchanged and failed branch reads idle, then publishes recovered branch changes", async () => {
    const original = branch("original-reply", true);
    const requestUpdate = vi.fn();
    const { state } = createSessionEventState({
      ...withBranches([original]),
      requestUpdate,
    });
    const listBranches = vi
      .mocked(state.sessions.listBranches)
      .mockResolvedValueOnce([{ ...original }])
      .mockRejectedValueOnce(new Error("Branch read failed"));
    await loadChatBranches(state);
    expect(requestUpdate).not.toHaveBeenCalled();
    invalidateChatBranches(state);
    await loadChatBranches(state);
    expect(state.chatBranches).toEqual([original]);
    expect(state.chatBranchesConnectionEpoch).toBeNull();
    expect(requestUpdate).not.toHaveBeenCalled();

    const recovered = { ...original, headline: "Recovered reply", messageCount: 3 };
    listBranches.mockResolvedValueOnce([recovered]);
    await loadChatBranches(state);
    expect(state.chatBranches).toEqual([recovered]);
    expect(state.chatBranchesConnectionEpoch).toBe(1);
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it.each([
    { role: "assistant", historyPending: false },
    { role: "toolResult", historyPending: false },
    { role: "assistant", historyPending: true },
  ])(
    "refreshes branches after persisted $role (history pending: $historyPending)",
    async ({ role, historyPending }) => {
      const original = branch();
      const replacement = { ...branch("replacement-reply", true), headline: "Replacement reply" };
      const { request, state } = createSessionEventState(withBranches([original]));
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
        chatEvent(state, {
          state: "delta",
          deltaText: "Replacement",
          message: { role: "assistant", content: [{ type: "text", text: "Replacement" }] },
        });
        expect(state.chatStream).toBe("Replacement");
        expect(listBranches).not.toHaveBeenCalled();
        chatEvent(state, {
          state: role === "toolResult" ? "aborted" : "final",
          message: { role: "assistant", content: "Replacement reply" },
        });
      }
      persistedMessage(state, role);
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
    const original = branch();
    const replacement = { ...original, leafEntryId: "replacement", active: true };
    const { state } = createSessionEventState(withBranches([original]));
    const stale = createDeferred<SessionBranch[]>();
    const listBranches = vi
      .mocked(state.sessions.listBranches)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue([replacement, original]);
    const pending = loadChatBranches(state);
    persistedMessage(state, "user", "replacement", 3, () => false);
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
