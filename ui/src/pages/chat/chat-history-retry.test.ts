// @vitest-environment node
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
} from "../../api/gateway-socket.test-support.ts";
import { GatewayBrowserClient, GatewayRequestError } from "../../api/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { requestSharedHistory } from "./chat-history-request.ts";
import { formatChatHistoryLoadError } from "./chat-history-retry.ts";
import { getChatHistoryLoadState, isChatHistoryRetrying } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function readHistory(client: GatewayBrowserClient, key: string, isCurrent = () => true) {
  return requestSharedHistory(
    null,
    client,
    key,
    "chat.history",
    "main",
    undefined,
    {},
    { isCurrent },
  );
}

describe("shared chat history transient recovery", () => {
  it.each([
    {
      message:
        "Agent main has not completed startup inspection and preparation.\nSessions remain unavailable until background inspection finishes.",
      details: {
        agentId: "main",
        paths: ["/private/state/agents/main/openclaw-agent.sqlite"],
        code: "agent-database-inspection-pending",
        reason: "Agent main has not completed startup inspection and preparation.",
        repairHint: "Run Doctor if inspection cannot complete.",
      },
      retryable: true,
      retryAfterMs: 250,
      expected: "This agent is still starting. Retry in a moment.",
    },
    {
      message: "Agent database inspection failed. Run Doctor.",
      details: {
        code: "agent-database-inspection-failed",
      },
      retryable: false,
      expected: "Agent database inspection failed. Run Doctor.",
    },
  ])("formats $details.code for the operator", ({ expected, ...params }) => {
    const error = new GatewayRequestError({ code: "UNAVAILABLE", ...params });
    expect(formatChatHistoryLoadError(error)).toBe(expected);
  });

  it.each([false, true])(
    "keeps manual Retry after the recovery deadline (startup=%s)",
    async (startup) => {
      vi.useFakeTimers();
      const method = startup ? "chat.startup" : "chat.history";
      const request = vi
        .fn()
        .mockRejectedValue(
          new GatewayProtocolRequestTimeoutError({ method, timeoutMs: 30_000, requestSent: true }),
        );
      const messages = [{ role: "assistant", content: "Cached transcript" }];
      const state = makeChatHost({
        sessionKey: "agent:main:history-timeout",
        requestHandlers: { [method]: request },
        chatMessages: messages,
        chatMessagesBySession: new Map(),
        chatMessage: "Unsent draft",
        chatAttachments: [
          { id: "draft", mimeType: "image/png", dataUrl: "data:image/png;base64,aQ==" },
        ],
      });
      cacheChatSessionSnapshot(
        state.chatMessagesBySession!,
        state,
        { sessionKey: state.sessionKey },
        {
          messages,
          pagination: { hasMore: false, completeSnapshot: true },
          sessionId: "cached-session",
        },
      );
      const attachments = state.chatAttachments;
      const loading = loadChatHistory(state, { startup, deferBranches: true });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(state.chatLoading).toBe(true);
      expect(isChatHistoryRetrying(state)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await loading;
      expect(getChatHistoryLoadState(state)).toMatchObject({
        phase: "failed",
        retryable: true,
        startup,
        message: expect.stringContaining("timed out"),
      });
      expect(state.chatLoading).toBe(false);
      expect(isChatHistoryRetrying(state)).toBe(false);
      expect(state.chatMessages).toEqual(messages);
      expect(
        readChatMessagesFromCache(state.chatMessagesBySession!, state, {
          sessionKey: state.sessionKey,
        }),
      ).toEqual(messages);
      expect(state.chatMessage).toBe("Unsent draft");
      expect(state.chatAttachments).toBe(attachments);
      expect(vi.getTimerCount()).toBe(0);

      request.mockResolvedValue({ messages, sessionId: "cached-session", completeSnapshot: true });
      await loadChatHistory(state, { startup, deferBranches: true });
      expect(getChatHistoryLoadState(state)).toMatchObject({ phase: "committed" });
      expect(state.chatMessage).toBe("Unsent draft");
      expect(state.request.mock.calls.every(([calledMethod]) => calledMethod === method)).toBe(
        true,
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    {
      error: new GatewayRequestError({
        code: "RATE_LIMITED",
        message: "Rate limited",
        retryable: true,
      }),
      retryable: true,
      elapsedMs: 0,
    },
    {
      error: new GatewayRequestError({
        code: "PERMISSION_DENIED",
        message: "Permission denied",
        retryable: false,
      }),
      retryable: false,
      elapsedMs: 0,
    },
    {
      error: new GatewayProtocolRequestTimeoutError({
        method: "chat.send",
        timeoutMs: 30_000,
        requestSent: true,
      }),
      retryable: false,
      elapsedMs: 0,
    },
    {
      error: new GatewayProtocolRequestTimeoutError({
        method: "chat.history",
        timeoutMs: 30_000,
        requestSent: true,
      }),
      retryable: true,
      elapsedMs: 60_000,
    },
  ])(
    "preserves manual retry policy for $error.name after $elapsedMs ms",
    async ({ error, retryable, elapsedMs }) => {
      vi.useFakeTimers();
      const state = makeChatHost({
        requestHandlers: {
          "chat.history": () => {
            // A suspended tab can observe an RPC timeout before its overdue reader timer runs.
            vi.setSystemTime(Date.now() + elapsedMs);
            return Promise.reject(error);
          },
        },
      });
      await loadChatHistory(state, { deferBranches: true });
      expect(getChatHistoryLoadState(state)).toMatchObject({ phase: "failed", retryable });
      expect(state.request).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not publish an old pane timeout over the newly loaded conversation", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(
      new GatewayProtocolRequestTimeoutError({
        method: "chat.history",
        timeoutMs: 30_000,
        requestSent: true,
      }),
    );
    const state = makeChatHost({ requestHandlers: { "chat.history": request } });
    const loading = loadChatHistory(state, { deferBranches: true });
    await vi.advanceTimersByTimeAsync(0);
    state.sessionKey = "agent:main:replacement";
    const messages = [{ role: "assistant", content: "Replacement conversation" }];
    request.mockResolvedValue({ messages });
    await loadChatHistory(state, { deferBranches: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await loading;
    expect(getChatHistoryLoadState(state)).toMatchObject({
      phase: "committed",
      sessionKey: state.sessionKey,
    });
    expect(state.chatMessages).toEqual(messages);
    expect(state.chatLoading).toBe(false);
    expect(state.request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a missing WebSocket response through the browser client's real request deadline", async () => {
    vi.useFakeTimers();
    stubWindowGlobals();
    vi.stubGlobal("WebSocket", MockWebSocket);
    // No RNG means no paired identity; this fixture exercises RPC deadlines, not signing.
    vi.stubGlobal("crypto", { randomUUID: () => "history-timeout-fixture" });
    const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789" });
    onTestFinished(() => client.stop());
    client.start();
    const socket = getLatestWebSocket();
    socket.emitOpen();
    socket.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "fixture", ts: Date.now() },
    });
    await vi.advanceTimersByTimeAsync(0);
    const connect = JSON.parse(socket.sent[0]!);
    socket.emitMessage({
      type: "res",
      id: connect.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [], recoveryScope: "fixture-owner" },
        policy: { tickIntervalMs: 60_000 },
      },
    });
    expect(client.connected).toBe(true);
    const read = readHistory(client, "real-wire");
    const outcome = read.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_000);
    socket.emitMessage({ type: "event", event: "tick", payload: {} });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(socket.sent.map((frame) => JSON.parse(frame).method)).toEqual([
      "connect",
      "chat.history",
    ]);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent.map((frame) => JSON.parse(frame).method)).toEqual([
      "connect",
      "chat.history",
      "chat.history",
    ]);
    const retry = JSON.parse(socket.sent[2]!);
    socket.emitMessage({ type: "res", id: retry.id, ok: true, payload: { messages: [] } });
    await expect(outcome).resolves.toEqual({ messages: [] });
    expect(client.connected).toBe(true);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "expires readers before a long server hint (staggered=%s)",
    async (staggered) => {
      vi.useFakeTimers();
      const request = vi.fn().mockRejectedValue(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Busy",
          retryable: true,
          retryAfterMs: 120_000,
        }),
      );
      const client = createTestGatewayClient(request);
      const first = readHistory(client, "long-delay").catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      let secondSettled = false;
      const second = staggered
        ? readHistory(client, "long-delay")
            .catch((error: unknown) => error)
            .finally(() => {
              secondSettled = true;
            })
        : undefined;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await first).toMatchObject({ message: expect.stringContaining("timed out") });
      expect(request).toHaveBeenCalledTimes(1);
      if (second) {
        expect(secondSettled).toBe(true);
        expect(await second).toMatchObject({ message: expect.stringContaining("timed out") });
        expect(request).toHaveBeenCalledTimes(1);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("never retries a timed-out read once all pane owners have changed", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(
      new GatewayProtocolRequestTimeoutError({
        method: "chat.history",
        timeoutMs: 30_000,
        requestSent: true,
      }),
    );
    const client = createTestGatewayClient(request);
    let current = true;
    const outcome = readHistory(client, "retired", () => current).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(await outcome).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries one timed-out read for current panes and preserves the shared request", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayProtocolRequestTimeoutError({
          method: "chat.history",
          timeoutMs: 30_000,
          requestSent: true,
        }),
      )
      .mockResolvedValueOnce({ messages: [{ role: "assistant", content: "Recovered" }] });
    const client = createTestGatewayClient(request);
    const first = readHistory(client, "shared");
    const second = readHistory(client, "shared");
    const outcomes = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await outcomes).toEqual([
      { status: "fulfilled", value: { messages: [{ role: "assistant", content: "Recovered" }] } },
      { status: "fulfilled", value: { messages: [{ role: "assistant", content: "Recovered" }] } },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
