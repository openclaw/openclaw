// @vitest-environment node
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
} from "../../api/gateway-socket.test-support.ts";
import { GatewayBrowserClient, GatewayRequestError } from "../../api/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { loadOlderChatHistoryPage, requestSharedHistory } from "./chat-history-request.ts";
import { getChatHistoryLoadState, isChatHistoryRetrying } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";

let historyClient: GatewayBrowserClient | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  historyClient?.stop();
  historyClient = undefined;
  await vi.advanceTimersByTimeAsync(0);
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
  historyClient = client;
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
  socket.emitConnectChallenge({ nonce: "fixture", ts: Date.now() });
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
  const reads = () => socket.sent.map((frame) => JSON.parse(frame));
  const reply = (id: string, messages: unknown[]) =>
    socket.emitMessage({ type: "res", id, ok: true, payload: { messages } });
  return { client, socket, timing, reads, reply };
}
const timeout = (method = "chat.history") =>
  new GatewayProtocolRequestTimeoutError({ method, timeoutMs: 30_000, requestSent: true });
const rejectedTimeout = () => vi.fn().mockRejectedValue(timeout());
const requestError = (code: string, message: string, retryable: boolean, retryAfterMs?: number) =>
  new GatewayRequestError({ code, message, retryable, retryAfterMs });

describe("shared chat history transient recovery", () => {
  it.each([
    ["older", "recover"],
    ["older", "retire"],
    ["older", "denied"],
    ["shared", "recover"],
    ["shared", "retire"],
  ])("settles a %s read after %s without stale or denied replay", async (kind, outcome) => {
    const error =
      kind === "shared"
        ? timeout()
        : requestError(
            outcome === "denied" ? "PERMISSION_DENIED" : "UNAVAILABLE",
            "Earlier history unavailable",
            outcome !== "denied",
            250,
          );
    const page = { messages: [{ role: "assistant", content: "Recovered" }], hasMore: false };
    const request = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(page);
    const state = makeChatHost({ requestHandlers: { "chat.history": request } });
    const isCurrent = () => state.sessionKey !== "agent:main:replacement";
    const reads =
      kind === "older"
        ? [loadOlderChatHistoryPage(state, { cursor: "older-80" })]
        : [
            readHistory(state.client!, "shared", isCurrent),
            readHistory(state.client!, "shared", isCurrent),
          ];
    const outcomes = Promise.all(reads).catch((failure: unknown) => failure);
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === "retire") {
      state.sessionKey = "agent:main:replacement";
    }
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    if (outcome === "recover") {
      expect(await outcomes).toEqual(reads.map(() => page));
    } else {
      expect(await outcomes).toBe(error);
    }
    expect(request).toHaveBeenCalledTimes(outcome === "recover" ? 2 : 1);
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
    const { client, socket, reads, reply } = await connectHistoryClient();
    const read = readHistory(client, "real-wire");
    const outcome = read.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_000);
    socket.emitMessage({ type: "event", event: "tick", payload: {} });
    await vi.advanceTimersByTimeAsync(1_499);
    const historyReads = () => reads().filter((frame) => frame.method === "chat.history");
    expect(historyReads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(historyReads()).toHaveLength(2);
    const retry = historyReads()[1]!;
    reply(retry.id, []);
    await expect(outcome).resolves.toEqual({ messages: [] });
    expect(client.connected).toBe(true);
  });

  it.each([false, true])("releases a retired wire consumer (joined=%s)", async (joined) => {
    const { client, timing, reads, reply } = await connectHistoryClient();
    const retired = new AbortController();
    const settled = vi.fn();
    const first = readHistory(client, "retirement-wire", () => true, retired.signal)
      .catch((error: unknown) => error)
      .finally(settled);
    const second = joined
      ? readHistory(client, "retirement-wire", () => true, new AbortController().signal)
      : undefined;
    void second?.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const obsolete = reads()[1]!;
    retired.abort();
    // Rejoin synchronously: cleanup of the retired producer may still be queued.
    const replacement = second ?? readHistory(client, "retirement-wire");
    void replacement.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledOnce();
    await first;
    expect(reads()).toHaveLength(joined ? 2 : 3);
    if (joined) {
      expect(timing.mock.calls.filter(([event]) => event.method === "chat.history")).toEqual([]);
    } else {
      expect(timing).toHaveBeenCalledWith(
        expect.objectContaining({
          id: obsolete.id,
          method: "chat.history",
          ok: false,
          errorCode: "CLIENT_ABORTED",
        }),
      );
      expect(reads()[2]!.id).not.toBe(obsolete.id);
      reply(obsolete.id, ["obsolete"]);
    }
    reply((joined ? obsolete : reads()[2]!).id, [joined ? "current" : "fresh"]);
    await expect(replacement).resolves.toEqual({ messages: [joined ? "current" : "fresh"] });
  });

  it("expires staggered readers before a long server hint", async () => {
    const request = vi.fn().mockRejectedValue(requestError("UNAVAILABLE", "Busy", true, 120_000));
    const client = createTestGatewayClient(request);
    const first = readHistory(client, "long-delay").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const secondSettled = vi.fn();
    const second = readHistory(client, "long-delay")
      .catch((error: unknown) => error)
      .finally(secondSettled);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toMatchObject({ message: expect.stringContaining("timed out") });
    expect(request).toHaveBeenCalledTimes(1);
    expect(secondSettled).toHaveBeenCalledOnce();
    expect(await second).toMatchObject({ message: expect.stringContaining("timed out") });
  });
});
