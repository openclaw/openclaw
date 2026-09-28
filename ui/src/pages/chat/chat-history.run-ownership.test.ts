// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResponse, ChatHistoryResult } from "./chat-history-snapshot.ts";
import { activeHistory, createState } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  adoptStartedChatRun,
  handleAbortChat,
  reconcileChatRunLifecycle,
} from "./run-lifecycle.ts";

describe("chat history run ownership recovery", () => {
  it.each(["page", "delta"] as const)(
    "recovers stale Stop ownership from a fresh %s without aborting the replacement run",
    async (kind) => {
      const initial = activeHistory("run-missed-terminal");
      initial.sessionInfo!.sessionId = "same-session";
      initial.inFlightRun!.text = "The old response.";
      if (kind === "delta") {
        initial.deltaCursor = "before-replacement";
      }
      const replacement = activeHistory("run-current");
      replacement.sessionInfo!.sessionId = "same-session";
      replacement.sessionInfo!.lastRunId = "run-current";
      replacement.inFlightRun!.text = "The current response.";
      const recovered: ChatHistoryResponse =
        kind === "delta"
          ? {
              ...replacement,
              kind: "delta",
              messages: [],
              sessionInfo: replacement.sessionInfo!,
              deltaCursor: "after-replacement",
            }
          : replacement;
      let response: ChatHistoryResponse = initial;
      const request = vi.fn((method: string) => {
        if (method === "chat.abort") {
          return Promise.resolve({ aborted: false });
        }
        if (method === "chat.history") {
          return Promise.resolve(response);
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const abortCalls = () => request.mock.calls.filter(([method]) => method.endsWith(".abort"));
      const state = Object.assign(createState(initial), {
        chatLocalInputHistoryBySession: {},
        chatInputHistorySessionKey: null,
        chatInputHistoryItems: null,
        chatInputHistoryIndex: -1,
        chatDraftBeforeHistory: null,
        refreshCurrentChat: async () => {
          await loadChatHistory(state);
        },
      });
      state.client = { request } as unknown as GatewayBrowserClient;
      await loadChatHistory(state);
      expect(state.chatRunId).toBe("run-missed-terminal");
      response = recovered;

      await handleAbortChat(state, { preserveDraft: true });

      expect(abortCalls()).toEqual([
        ["chat.abort", { sessionKey: "main", runId: "run-missed-terminal" }],
      ]);
      expect(state.chatRunId).toBe("run-current");
      expect(state.chatStream).toBe("The current response.");
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "run-current",
        state: "delta",
        message: { role: "assistant", content: "The current response. Continued." },
      });
      expect(state.chatStream).toBe("The current response. Continued.");

      await handleAbortChat(state, { preserveDraft: true });

      expect(abortCalls()).toEqual([
        ["chat.abort", { sessionKey: "main", runId: "run-missed-terminal" }],
        ["chat.abort", { sessionKey: "main", runId: "run-current" }],
      ]);
    },
  );

  it.each([
    { name: "still includes the local run", row: { activeRunIds: ["run-owned", "run-history"] } },
    { name: "omits exact active identities", row: { activeRunIds: undefined } },
    { name: "belongs to a replacement session", row: { sessionId: "different-session" } },
  ])("retains local ownership when history $name", async ({ row }) => {
    const history = activeHistory("run-history");
    history.sessionInfo = { ...history.sessionInfo!, sessionId: "same-session", ...row };
    const state = createState(history);
    state.currentSessionId = "same-session";
    adoptStartedChatRun(state, "run-owned", 1);
    state.chatStream = "Still locally owned.";

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-owned");
    expect(state.chatStream).toBe("Still locally owned.");
  });

  it.each(["live delta", "lifecycle restart", "pending send"] as const)(
    "does not replace an owned run after a %s while history is pending",
    async (change) => {
      const history = activeHistory("run-history");
      history.sessionInfo!.sessionId = "same-session";
      const pending = createDeferred<ChatHistoryResult>();
      const request = vi.fn().mockReturnValue(pending.promise);
      const state = createState(history);
      state.client = { request } as unknown as GatewayBrowserClient;
      state.currentSessionId = "same-session";
      adoptStartedChatRun(state, "run-owned", 1);
      const loading = loadChatHistory(state);
      expect(request).toHaveBeenCalledOnce();
      if (change === "lifecycle restart") {
        reconcileChatRunLifecycle(state, { clearLocalRun: true, requestUpdate: false });
        adoptStartedChatRun(state, "run-owned", 2);
      } else if (change === "pending send") {
        state.chatQueue.push({
          id: "pending",
          text: "Newer request",
          createdAt: 2,
          sendState: "sending",
          sendRunId: "run-pending",
        });
      } else {
        handleChatGatewayEvent(state, {
          sessionKey: "main",
          runId: "run-owned",
          state: "delta",
          message: { role: "assistant", content: "Newer live response." },
        });
      }
      const stream = state.chatStream;
      pending.resolve(history);
      await loading;

      expect(state.chatRunId).toBe("run-owned");
      expect(state.chatStream).toBe(stream);
    },
  );

  it("does not replace a late consumer's run with history issued for another pane", async () => {
    const history = activeHistory("run-history");
    history.sessionInfo!.sessionId = "same-session";
    const pending = createDeferred<ChatHistoryResult>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const first = createState(history);
    first.client = { request } as unknown as GatewayBrowserClient;
    first.currentSessionId = "same-session";
    adoptStartedChatRun(first, "run-owned", 1);
    const second = createState(history);
    second.client = first.client;
    second.sessions = first.sessions;
    second.currentSessionId = "same-session";
    adoptStartedChatRun(second, "run-owned", 1);

    const firstLoad = loadChatHistory(first);
    const secondLoad = loadChatHistory(second);
    expect(request).toHaveBeenCalledOnce();
    pending.resolve(history);
    await Promise.all([firstLoad, secondLoad]);

    expect(first.chatRunId).toBe("run-history");
    expect(second.chatRunId).toBe("run-owned");
  });
});
