/* @vitest-environment jsdom */

import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createRefreshChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import * as paneTest from "./chat-pane.test-support.ts";

it("automatically restores live observation after a subscription timeout without a composer error", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const sessionKey = "agent:main:subscription-recovery";
  const messages = [nativeHistoryMessage(2, "The node completed the work.")];
  let observing = false;
  const subscriptions: unknown[] = [];
  const client = paneTest.createGatewayBrowserClientFixture({
    request: async (method, params) => {
      if (method === "sessions.messages.subscribe") {
        subscriptions.push(params);
        observing = true;
        if (subscriptions.length === 1) {
          throw new GatewayProtocolRequestTimeoutError({
            method,
            timeoutMs: 30_000,
            requestSent: true,
          });
        }
        return { subscribed: true, key: sessionKey };
      }
      if (method === "sessions.messages.unsubscribe") {
        observing = false;
        return { subscribed: false, key: sessionKey };
      }
      return { messages, completeSnapshot: true, sessionId: "subscription-recovery" };
    },
  });
  const { state } = createRefreshChatPane(client);
  state.sessionKey = sessionKey;
  state.hello = gatewayHelloForMethods([], ["operator.read", "operator.approvals"]);

  const settleObserved = async (read: Promise<unknown>, delay: number) => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(delay);
    await read;
    expect(state.chatError).toBeNull();
    expect(observing).toBe(true);
  };
  await settleObserved(syncSelectedSessionMessageSubscription(state), 500);
  await settleObserved(loadChatHistory(state), 0);
  expect(state.chatMessages).toEqual(messages);
  const expected = { subscriptionId: expect.any(String), key: sessionKey, includeApprovals: true };
  expect(subscriptions).toEqual([expected, expected]);
});

it("reports each transcript loading edge from the load owner", async () => {
  const pane = paneTest.createRenderTestChatPane();
  const responses = Array.from({ length: 2 }, () => createDeferred<ChatHistoryResult>());
  const pending = responses.map(({ promise }) => promise);
  const client = paneTest.createGatewayBrowserClientFixture({ request: () => pending.shift() });
  const context = {
    ...paneTest.createInitializationContext(),
    sessions: paneTest.createSessionCapabilityFixture({
      state: { agentId: "main" },
      reconcile: vi.fn(),
    }),
  };
  Object.assign(context.gateway.snapshot, { client, phase: "connected" });
  const state = pane.initialize(context);
  Object.assign(state, { client, connected: true, sessionKey: "agent:main:signal" });
  const changed = vi.fn();
  pane.addEventListener("openclaw-chat-transcript-loading-changed", changed);

  for (const [index, response] of responses.entries()) {
    const loading = loadChatHistory(state);
    expect(pane.transcriptLoading).toBe(true);
    expect(changed).toHaveBeenCalledTimes(index * 2 + 1);
    if (index === 0) {
      void loadChatHistory(state);
      expect(changed).toHaveBeenCalledOnce();
    }
    response.resolve({ completeSnapshot: true, messages: [], sessionId: "id:signal" });
    await loading;
    expect(pane.transcriptLoading).toBe(false);
    expect(changed).toHaveBeenCalledTimes(index * 2 + 2);
  }
});
