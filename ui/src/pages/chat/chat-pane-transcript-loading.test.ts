/* @vitest-environment jsdom */

import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createRefreshChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createRenderTestChatPane,
  createSessionCapabilityFixture,
} from "./chat-pane.test-support.ts";

describe("chat pane transcript loading", () => {
  it("restores live observation when refreshing after a subscription timeout", async () => {
    const sessionKey = "agent:main:subscription-recovery";
    const messages = [nativeHistoryMessage(2, "The node completed the work.")];
    let failSubscription = true;
    let observing = false;
    const subscriptions: unknown[] = [];
    const client = createGatewayBrowserClientFixture({
      request: async (method, params) => {
        if (method === "sessions.messages.subscribe") {
          subscriptions.push(params);
          observing = true;
          if (failSubscription) {
            failSubscription = false;
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
    const { pane, state } = createRefreshChatPane(client);
    state.sessionKey = sessionKey;
    state.hello = gatewayHelloForMethods([], ["operator.read", "operator.approvals"]);

    await syncSelectedSessionMessageSubscription(state);
    expect(state.chatError).toContain("sessions.messages.subscribe");
    expect(observing).toBe(false);

    pane.render();
    pane.chatProps!.onRefresh();

    await vi.waitFor(() => expect(state.chatMessages).toEqual(messages));
    expect(observing).toBe(true);
    expect(subscriptions).toEqual([
      { key: sessionKey, includeApprovals: true },
      { key: sessionKey, includeApprovals: true },
    ]);
    expect(state.chatError).toBeNull();
  });

  it("reports each transcript loading edge from the load owner without a render", async () => {
    const pane = createRenderTestChatPane();
    const first = createDeferred<ChatHistoryResult>();
    const second = createDeferred<ChatHistoryResult>();
    const pending = [first.promise, second.promise];
    const request = vi.fn(() => pending.shift());
    const client = { request } as unknown as GatewayBrowserClient;
    const context: ApplicationContext = {
      ...createInitializationContext(),
      sessions: createSessionCapabilityFixture({
        state: { result: null, agentId: "main", modelOverrides: {} },
        think: () => undefined,
        reconcile: vi.fn(),
      }),
    };
    context.gateway.snapshot.client = client;
    context.gateway.snapshot.phase = "connected";
    const state = pane.initialize(context);
    state.client = client;
    state.connected = true;
    state.sessionKey = "agent:main:signal";
    const invalidate = vi.spyOn(state.renderLifecycle, "invalidate");
    const changed = vi.fn();
    pane.addEventListener("openclaw-chat-transcript-loading-changed", changed);

    // Session-event reloads never re-render the page, so the load owner reports
    // the edge itself, without spending a frame on it.
    const firstLoad = loadChatHistory(state);
    expect(pane.transcriptLoading).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();

    // A coalesced re-entry into the same in-flight request is not an edge.
    void loadChatHistory(state);
    expect(changed).toHaveBeenCalledOnce();

    first.resolve({ completeSnapshot: true, messages: [], sessionId: "id:signal" });
    await firstLoad;
    expect(pane.transcriptLoading).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);

    const secondLoad = loadChatHistory(state);
    expect(changed).toHaveBeenCalledTimes(3);
    second.resolve({ completeSnapshot: true, messages: [], sessionId: "id:signal" });
    await secondLoad;
    expect(changed).toHaveBeenCalledTimes(4);
  });
});
