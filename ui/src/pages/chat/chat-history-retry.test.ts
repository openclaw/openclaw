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

function readHistory(
  client: GatewayBrowserClient,
  key: string,
  isCurrent = () => true,
  signal?: AbortSignal,
) {
  const observation = { isCurrent, signal };
  return requestSharedHistory(
    null,
    client,
    key,
    "chat.history",
    "main",
    undefined,
    {},
    observation,
  );
}

async function connectHistoryClient() {
  stubWindowGlobals();
  vi.stubGlobal("WebSocket", MockWebSocket);
  // No RNG means no paired identity; this fixture exercises RPC ownership, not signing.
  vi.stubGlobal("crypto", { randomUUID: () => "history-read-fixture" });
  const timing = vi.fn();
  const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789", onRequestTiming: timing });
  onTestFinished(() => client.stop());
  client.start();
  const socket = getLatestWebSocket();
  const send = socket.send.bind(socket);
  vi.spyOn(socket, "send").mockImplementation((data) => {
    send(data);
    const frame = JSON.parse(data);
    // A held history read still has a live server; answer its real liveness probe.
    if (frame.method === "health") {
      socket.emitMessage({ type: "res", id: frame.id, ok: true, payload: {} });
    }
  });
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
  return { client, socket, timing };
}
const timeout = (method = "chat.history") =>
  new GatewayProtocolRequestTimeoutError({ method, timeoutMs: 30_000, requestSent: true });
const rejectedTimeout = () => vi.fn().mockRejectedValue(timeout());
const requestError = (code: string, message: string, retryable: boolean, retryAfterMs?: number) =>
  new GatewayRequestError({ code, message, retryable, retryAfterMs });

describe("shared chat history transient recovery", () => {
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
      if (error instanceof GatewayRequestError) {
        expect(getChatHistoryLoadState(state)).toMatchObject({ message: error.message });
      }
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
    const { client, socket } = await connectHistoryClient();
    try {
      const read = readHistory(client, "real-wire");
      const outcome = read.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(29_000);
      socket.emitMessage({ type: "event", event: "tick", payload: {} });
      await vi.advanceTimersByTimeAsync(1_499);
      const reads = () =>
        socket.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.method === "chat.history");
      expect(reads()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads()).toHaveLength(2);
      const retry = reads()[1]!;
      socket.emitMessage({ type: "res", id: retry.id, ok: true, payload: { messages: [] } });
      await expect(outcome).resolves.toEqual({ messages: [] });
      expect(client.connected).toBe(true);
    } finally {
      client.stop();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("releases retired consumers without canceling a joined reader, then retires the last wire correlation", async () => {
    const { client, socket, timing } = await connectHistoryClient();
    try {
      const retired = new AbortController();
      const current = new AbortController();
      let retiredSettled = false;
      const first = readHistory(client, "joined-wire", () => true, retired.signal)
        .catch((error: unknown) => error)
        .finally(() => {
          retiredSettled = true;
        });
      const second = readHistory(client, "joined-wire", () => true, current.signal);
      // Cleanup also rejects the joined read when the baseline stops at its red assertion.
      void second.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      const joined = JSON.parse(socket.sent[1]!);
      retired.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(retiredSettled).toBe(true);
      await first;
      expect(socket.sent).toHaveLength(2);
      expect(timing.mock.calls.filter(([event]) => event.method === "chat.history")).toEqual([]);
      socket.emitMessage({
        type: "res",
        id: joined.id,
        ok: true,
        payload: { messages: ["current"] },
      });
      await expect(second).resolves.toEqual({ messages: ["current"] });

      const last = new AbortController();
      let lastSettled = false;
      const abandoned = readHistory(client, "retired-wire", () => true, last.signal)
        .catch((error: unknown) => error)
        .finally(() => {
          lastSettled = true;
        });
      await vi.advanceTimersByTimeAsync(0);
      const obsolete = JSON.parse(socket.sent[2]!);
      last.abort();
      const replacement = readHistory(client, "retired-wire");
      void replacement.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(lastSettled).toBe(true);
      await abandoned;
      expect(timing).toHaveBeenCalledWith(
        expect.objectContaining({
          id: obsolete.id,
          method: "chat.history",
          ok: false,
          errorCode: "CLIENT_ABORTED",
        }),
      );
      const fresh = JSON.parse(socket.sent[3]!);
      expect(fresh.id).not.toBe(obsolete.id);
      socket.emitMessage({
        type: "res",
        id: obsolete.id,
        ok: true,
        payload: { messages: ["obsolete"] },
      });
      socket.emitMessage({ type: "res", id: fresh.id, ok: true, payload: { messages: ["fresh"] } });
      await expect(replacement).resolves.toEqual({ messages: ["fresh"] });
    } finally {
      client.stop();
      await vi.advanceTimersByTimeAsync(0);
    }
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
