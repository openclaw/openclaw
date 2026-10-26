/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { requestCalls } from "./chat-host.test-support.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

const agentsList: AgentsListResult = makeBootRoster();

function createCanonicalRoutePane(
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {},
  fallback: () => unknown = () => ({}),
) {
  const request = vi.fn((method: string, params: Record<string, unknown>) =>
    Promise.resolve(method === "agents.list" ? agentsList : (handlers[method] ?? fallback)(params)),
  );
  const client = { request } as unknown as GatewayBrowserClient;
  const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
  vi.spyOn(sessions, "listBranches").mockResolvedValue([]);
  const { pane, state } = createTestChatPane({ client, sessions });
  Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
  const sessionDefaults = {
    defaultAgentId: "main",
    mainKey: "main",
    mainSessionKey: "agent:main:main",
  };
  const hello = { snapshot: { sessionDefaults } } as NonNullable<typeof state.hello>;
  state.hello = hello;
  state.settings = {
    sessionKey: state.sessionKey,
    lastActiveSessionKey: state.sessionKey,
  } as typeof state.settings;
  Object.assign(pane, { sessionKey: "main", connectedClient: null, active: true, presented: true });
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  const snapshot = {
    ...pane.context.gateway.snapshot,
    assistantAgentId: "main",
    client,
    hello,
    phase: "connected" as const,
  };
  return { pane, state, snapshot, request };
}

function assistantHistory(text: string) {
  return { messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
}

it("shows the subscribed initial transcript without another history round trip", async () => {
  const { pane, state, snapshot, request } = createCanonicalRoutePane({
    "sessions.messages.subscribe": () => ({
      key: "agent:main:current",
      initialHistory: { ok: true, payload: assistantHistory("Initial subscription transcript") },
    }),
  });
  pane.sessionKey = state.sessionKey;
  pane.applyGatewaySnapshot(snapshot);
  await vi.waitFor(() =>
    expect(state.chatMessages).toEqual(
      assistantHistory("Initial subscription transcript").messages,
    ),
  );
  expect(getChatHistoryLoadState(state).phase).toBe("committed");
  expect(requestCalls(request, "chat.startup")).toHaveLength(0);
  expect(requestCalls(request, "sessions.messages.subscribe")[0]?.[1]).toMatchObject({
    initialHistory: { limit: 80, maxBytes: 256 * 1024, knownState: {} },
  });
});

async function expectRecoveredHistory(
  state: ReturnType<typeof createCanonicalRoutePane>["state"],
  request: ReturnType<typeof vi.fn>,
  method: "chat.history" | "chat.startup",
  attempts: number,
  text: string,
) {
  await vi.waitFor(() => expect(requestCalls(request, method)).toHaveLength(attempts));
  expect(request).toHaveBeenCalledWith(
    method,
    {
      sessionKey: state.sessionKey,
      knownState: {},
      limit: 80,
      maxBytes: 256 * 1024,
      toolResultMaxChars: 2_000,
    },
    { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
  );
  await vi.waitFor(() => expect(state.chatMessages).toEqual(assistantHistory(text).messages));
  expect(getChatHistoryLoadState(state).phase).toBe("committed");
}

it("does not request the optional header platform while initial history is pending", async () => {
  const subscribed = createDeferred();
  const historyStarted = createDeferred();
  const history = createDeferred<ReturnType<typeof assistantHistory>>();
  const { pane, state, snapshot, request } = createCanonicalRoutePane({
    "sessions.messages.subscribe": () => subscribed.promise.then(() => ({})),
    "chat.startup": () => {
      historyStarted.resolve();
      return history.promise;
    },
  });
  Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
  pane.sessionKey = state.sessionKey;
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  state.loadAssistantIdentity = vi.fn(async () => undefined);
  const hello = { ...snapshot.hello, features: { methods: ["system.info"], events: [] } };
  pane.context.gateway.snapshot.hello = hello;
  try {
    pane.applyGatewaySnapshot({ ...snapshot, hello });
    expect(requestCalls(request, "chat.startup")).toHaveLength(0);
    subscribed.resolve();
    await historyStarted.promise;
    expect(requestCalls(request, "chat.startup")).toHaveLength(1);
    expect(requestCalls(request, "system.info")).toEqual([]);
  } finally {
    history.resolve(assistantHistory("Selected transcript"));
    await history.promise;
  }
});

it.each([false, true])(
  "handles disconnected history after a route change (replaced=%s)",
  async (replaced) => {
    const { pane, state, snapshot, request } = createCanonicalRoutePane({}, () =>
      replaced ? {} : assistantHistory("Recovered transcript"),
    );
    state.connected = false;

    await loadChatHistory(state);

    expect(request).not.toHaveBeenCalled();
    expect(getChatHistoryLoadState(state)).toMatchObject({
      phase: "pending-connection",
      sessionKey: "agent:main:current",
      startup: false,
    });
    expect(state.chatLoading).toBe(true);

    if (replaced) {
      state.sessionKey = "agent:main:different-session";
      pane.applyGatewaySnapshot(snapshot);
      expect(requestCalls(request, "chat.history")).toHaveLength(0);
      expect(requestCalls(request, "chat.startup")).toHaveLength(0);
      expect(getChatHistoryLoadState(state)).toEqual({ phase: "idle" });
      expect(state.chatLoading).toBe(false);
    } else {
      pane.applyGatewaySnapshot(snapshot);
      expect(state.sessionKey).toBe("agent:main:current");
      await expectRecoveredHistory(state, request, "chat.history", 1, "Recovered transcript");
    }
  },
);

it("automatically retries a retryable history failure when the Gateway reconnects", async () => {
  const { pane, state, snapshot, request } = createCanonicalRoutePane({
    "chat.startup": vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "GATEWAY_UNAVAILABLE",
          message: "Gateway connection interrupted",
          retryable: true,
        }),
      )
      .mockResolvedValue(assistantHistory("Recovered after reconnect")),
  });

  await loadChatHistory(state, { startup: true });

  expect(getChatHistoryLoadState(state)).toMatchObject({
    phase: "failed",
    sessionKey: state.sessionKey,
    retryable: true,
    startup: true,
  });
  pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
  pane.applyGatewaySnapshot(snapshot);

  await expectRecoveredHistory(state, request, "chat.startup", 2, "Recovered after reconnect");
});
