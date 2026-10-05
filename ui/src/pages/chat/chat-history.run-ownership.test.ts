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
    "retires a stale run from a fresh idle %s after another run completed",
    async (kind) => {
      const initial = activeHistory("run-missed-terminal");
      initial.sessionInfo!.sessionId = "same-session";
      if (kind === "delta") {
        initial.deltaCursor = "before-completion";
      }
      const sessionInfo = {
        ...initial.sessionInfo!,
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: "run-completed-later",
        status: "done" as const,
      };
      const completed: ChatHistoryResponse =
        kind === "delta"
          ? { kind: "delta", messages: [], sessionInfo, deltaCursor: "after-completion" }
          : { messages: [], sessionInfo };
      const request = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(completed);
      const state = createState(initial);
      state.client = { request } as unknown as GatewayBrowserClient;
      await loadChatHistory(state);
      expect(state.chatRunId).toBe("run-missed-terminal");
      state.chatMessage = "An unsent draft";

      await loadChatHistory(state);

      expect(state.chatRunId).toBeNull();
      expect(state.chatStream).toBeNull();
      expect(state.chatStreamStartedAt).toBeNull();
      expect(state).toMatchObject({ chatRunStatus: null });
      expect(state.chatMessage).toBe("An unsent draft");
    },
  );

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

  it.each(
    [
      "active local run",
      "unknown active identities",
      "replacement session",
      "live delta",
      "lifecycle restart",
      "pending send",
      "late consumer",
    ].flatMap((change) =>
      (change === "active local run" || change === "unknown active identities"
        ? [false]
        : [false, true]
      ).map((idle) => ({ change, idle })),
    ),
  )("retains local ownership across $change (idle history: $idle)", async ({ change, idle }) => {
    const history = activeHistory("run-history");
    history.sessionInfo!.sessionId = "same-session";
    if (idle) {
      delete history.inFlightRun;
      Object.assign(history.sessionInfo!, {
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: "run-history",
        status: "done",
      });
    }
    if (change === "active local run") {
      history.sessionInfo!.activeRunIds = ["run-owned", "run-history"];
    } else if (change === "unknown active identities") {
      history.sessionInfo!.activeRunIds = undefined;
    } else if (change === "replacement session") {
      history.sessionInfo!.sessionId = "different-session";
    }
    const pending = createDeferred<ChatHistoryResult>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const state = createState(history);
    state.client = { request } as unknown as GatewayBrowserClient;
    state.currentSessionId = "same-session";
    adoptStartedChatRun(state, "run-owned", 1);
    const snapshotOnly = [
      "active local run",
      "unknown active identities",
      "replacement session",
    ].includes(change);
    if (snapshotOnly) {
      state.chatStream = "Still locally owned.";
    }
    const first = change === "late consumer" ? createState(history) : state;
    if (first !== state) {
      first.client = state.client;
      first.sessions = state.sessions;
      first.currentSessionId = "same-session";
      adoptStartedChatRun(first, "run-owned", 1);
    }
    const firstLoad = first !== state ? loadChatHistory(first) : undefined;
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
    } else if (change === "live delta") {
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "run-owned",
        state: "delta",
        message: { role: "assistant", content: "Newer live response." },
      });
    }
    const stream = state.chatStream;
    pending.resolve(history);
    await Promise.all([firstLoad, loading]);

    expect(state.chatRunId).toBe("run-owned");
    expect(state.chatStream).toBe(snapshotOnly ? "Still locally owned." : stream);
    if (first !== state) {
      expect(first.chatRunId).toBe(idle ? null : "run-history");
    }
  });
});
