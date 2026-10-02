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
import { getChatHistoryLoadState, isChatHistoryRetrying } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared chat history transient recovery", () => {
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
    },
    {
      error: new GatewayRequestError({
        code: "PERMISSION_DENIED",
        message: "Permission denied",
        retryable: false,
      }),
      retryable: false,
    },
    {
      error: new GatewayProtocolRequestTimeoutError({
        method: "chat.send",
        timeoutMs: 30_000,
        requestSent: true,
      }),
      retryable: false,
    },
  ])(
    "preserves manual retry policy for $error.name ($error.code)",
    async ({ error, retryable }) => {
      const state = makeChatHost({
        requestHandlers: { "chat.history": () => Promise.reject(error) },
      });
      await loadChatHistory(state, { deferBranches: true });
      expect(getChatHistoryLoadState(state)).toMatchObject({ phase: "failed", retryable });
      expect(state.request).toHaveBeenCalledOnce();
    },
  );

  it("keeps a matching late timeout manually retryable after the recovery window elapses", async () => {
    vi.useFakeTimers();
    const state = makeChatHost({
      requestHandlers: {
        "chat.history": async () => {
          // A suspended tab can observe an RPC timeout before its overdue reader timer runs.
          vi.setSystemTime(Date.now() + 60_000);
          throw new GatewayProtocolRequestTimeoutError({
            method: "chat.history",
            timeoutMs: 30_000,
            requestSent: true,
          });
        },
      },
    });
    await loadChatHistory(state, { deferBranches: true });
    expect(getChatHistoryLoadState(state)).toMatchObject({ phase: "failed", retryable: true });
    expect(state.request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

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
    const read = requestSharedHistory(
      null,
      client,
      "real-wire",
      "chat.history",
      "main",
      undefined,
      {},
      { isCurrent: () => true },
    );
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

  it("cancels the retry timer when the final reader reaches its existing deadline", async () => {
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
    const outcome = requestSharedHistory(
      null,
      client,
      "long-delay",
      "chat.history",
      "main",
      undefined,
      {},
      { isCurrent: () => true },
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toMatchObject({ message: expect.stringContaining("timed out") });
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires staggered readers independently without retrying before a long server hint", async () => {
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
    const first = requestSharedHistory(
      null,
      client,
      "staggered",
      "chat.history",
      "main",
      undefined,
      {},
      { isCurrent: () => true },
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    let secondSettled = false;
    const second = requestSharedHistory(
      null,
      client,
      "staggered",
      "chat.history",
      "main",
      undefined,
      {},
      { isCurrent: () => true },
    )
      .catch((error: unknown) => error)
      .finally(() => {
        secondSettled = true;
      });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toMatchObject({ message: expect.stringContaining("timed out") });
    expect(secondSettled).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await second).toMatchObject({ message: expect.stringContaining("timed out") });
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

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
    const outcome = requestSharedHistory(
      null,
      client,
      "retired",
      "chat.history",
      "main",
      undefined,
      {},
      { isCurrent: () => current },
    ).catch((error: unknown) => error);
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
    const first = requestSharedHistory(
      null,
      client,
      "shared",
      "chat.history",
      "main",
      undefined,
      {},
      { isCurrent: () => true },
    );
    const second = requestSharedHistory(
      null,
      client,
      "shared",
      "chat.history",
      "main",
      undefined,
      {},
      { isCurrent: () => true },
    );
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
