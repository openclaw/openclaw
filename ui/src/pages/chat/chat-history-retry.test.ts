// @vitest-environment node
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
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
const timeout = (method = "chat.history") =>
  new GatewayProtocolRequestTimeoutError({ method, timeoutMs: 30_000, requestSent: true });
const rejectedTimeout = () => vi.fn().mockRejectedValue(timeout());
const requestError = (code: string, message: string, retryable: boolean, retryAfterMs?: number) =>
  new GatewayRequestError({ code, message, retryable, retryAfterMs });

describe("shared chat history transient recovery", () => {
  it.each([
    {
      message: "Startup inspection pending: /private/agent.sqlite",
      details: {
        paths: ["/private/agent.sqlite"],
        code: "agent-database-inspection-pending",
      },
      retryable: true,
      expected: "This agent is still starting. Retry in a moment.",
    },
    {
      message: "Agent database inspection failed. Run Doctor.",
      details: { code: "agent-database-inspection-failed" },
      retryable: false,
    },
  ])("formats $details.code for the operator", ({ expected, ...params }) => {
    const error = new GatewayRequestError({ code: "UNAVAILABLE", ...params });
    expect(formatChatHistoryLoadError(error)).toBe(expected ?? params.message);
  });

  it.each([false, true])(
    "keeps manual Retry after the recovery deadline (startup=%s)",
    async (startup) => {
      const method = startup ? "chat.startup" : "chat.history";
      const request = vi.fn().mockRejectedValue(timeout(method));
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
      const snapshot = {
        messages,
        pagination: { hasMore: false, completeSnapshot: true } as const,
        sessionId: "cached-session",
      };
      const scope = { sessionKey: state.sessionKey };
      cacheChatSessionSnapshot(state.chatMessagesBySession!, state, scope, snapshot);
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
      expect(isChatHistoryRetrying(state)).toBe(false);
      expect(state).toMatchObject({
        chatLoading: false,
        chatMessage: "Unsent draft",
      });
      expect(state.chatMessages).toEqual(messages);
      expect(readChatMessagesFromCache(state.chatMessagesBySession!, state, scope)).toEqual(
        messages,
      );
      expect(state.chatAttachments).toBe(attachments);
      expect(vi.getTimerCount()).toBe(0);

      request.mockResolvedValue({ ...snapshot, completeSnapshot: true });
      await loadChatHistory(state, { startup, deferBranches: true });
      expect(getChatHistoryLoadState(state)).toMatchObject({ phase: "committed" });
      expect(state.chatMessage).toBe("Unsent draft");
      expect(state.request.mock.calls.every(([calledMethod]) => calledMethod === method)).toBe(
        true,
      );
    },
  );

  it.each([
    [requestError("RATE_LIMITED", "Rate limited", true), true, 0],
    [requestError("PERMISSION_DENIED", "Permission denied", false), false, 0],
    [timeout("chat.send"), false, 0],
    [timeout(), true, 60_000],
  ] as const)(
    "preserves manual retry policy for %s (retryable=%s, elapsed=%s)",
    async (error, retryable, elapsedMs) => {
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
    },
  );

  it("does not publish an old pane timeout over the newly loaded conversation", async () => {
    const request = rejectedTimeout();
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
  });

  it("retries a missing WebSocket response through the browser client's real request deadline", async () => {
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
    const methods = () => socket.sent.map((frame) => JSON.parse(frame).method);
    expect(methods()).toEqual(["connect", "chat.history"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(methods()).toEqual(["connect", "chat.history", "chat.history"]);
    const retry = JSON.parse(socket.sent[2]!);
    socket.emitMessage({ type: "res", id: retry.id, ok: true, payload: { messages: [] } });
    await expect(outcome).resolves.toEqual({ messages: [] });
    expect(client.connected).toBe(true);
    client.stop();
  });

  it("expires staggered readers before a long server hint", async () => {
    const request = vi.fn().mockRejectedValue(requestError("UNAVAILABLE", "Busy", true, 120_000));
    const client = createTestGatewayClient(request);
    const first = readHistory(client, "long-delay").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    let secondSettled = false;
    const second = readHistory(client, "long-delay")
      .catch((error: unknown) => error)
      .finally(() => {
        secondSettled = true;
      });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toMatchObject({ message: expect.stringContaining("timed out") });
    expect(request).toHaveBeenCalledTimes(1);
    expect(secondSettled).toBe(true);
    expect(await second).toMatchObject({ message: expect.stringContaining("timed out") });
  });

  it("never retries a timed-out read once all pane owners have changed", async () => {
    const request = rejectedTimeout();
    const client = createTestGatewayClient(request);
    let current = true;
    const outcome = readHistory(client, "retired", () => current).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(await outcome).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries one timed-out read for current panes and preserves the shared request", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce({ messages: [{ role: "assistant", content: "Recovered" }] });
    const client = createTestGatewayClient(request);
    const first = readHistory(client, "shared");
    const second = readHistory(client, "shared");
    const outcomes = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    const fulfilled = {
      status: "fulfilled",
      value: { messages: [{ role: "assistant", content: "Recovered" }] },
    };
    expect(await outcomes).toEqual([fulfilled, fulfilled]);
  });
});
