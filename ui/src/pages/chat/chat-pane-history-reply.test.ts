/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";

describe("chat pane reply-source history navigation", () => {
  it("uses page-carried originals across reconnects without fetching or inserting them", () => {
    const message = {
      role: "assistant",
      content: "Original answer",
      __openclaw: { id: "source-message" },
    };
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [
      {
        role: "user",
        content: "Follow-up",
        __openclaw: {
          replyToId: "source-message",
          replyToMessage: { ok: true, message },
        },
      },
    ];

    expect(pane.readReplyMessage("source-message")).toBe(message);
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    expect(pane.readReplyMessage("source-message")).toBe(message);
    expect(state.chatMessages).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();

    state.chatMessages = [];
    expect(pane.readReplyMessage("source-message")).toBeUndefined();
  });

  it.each([
    [undefined, "pending"],
    [{ ok: false, unavailableReason: "oversized" }, "oversized"],
    [{ ok: false, unavailableReason: "not_found" }, "missing"],
  ] as const)("preserves page-carried reply availability (%j)", (result, expected) => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: {} as SessionCapability,
    });
    state.chatMessages = [
      {
        role: "user",
        content: "Follow-up",
        __openclaw: { replyToId: "source-message", replyToMessage: result },
      },
    ];
    expect(pane.replyMessageStatus("source-message")).toBe(expected);
  });

  it("pages backward until a clicked reply target is loaded, then reveals it", async () => {
    const target = {
      ...nativeHistoryMessage(1, "Original answer"),
      __openclaw: { id: "source-message", seq: 1 },
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [nativeHistoryMessage(3), nativeHistoryMessage(4)],
        hasMore: true,
        nextOffset: 4,
        totalMessages: 6,
      })
      .mockResolvedValueOnce({
        messages: [target, nativeHistoryMessage(2)],
        hasMore: false,
        totalMessages: 6,
      });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [nativeHistoryMessage(5), nativeHistoryMessage(6)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 6 };
    vi.spyOn(pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
    const revealMessage = vi.spyOn(pane.transcript, "revealMessage").mockReturnValue(true);

    pane.openReplyMessage("source-message");

    expect(pane.currentReplyNavigationId(state.sessionKey)).toBe("source-message");
    await vi.waitFor(() => expect(revealMessage).toHaveBeenCalledWith("source-message"));
    expect(request).toHaveBeenNthCalledWith(1, "chat.history", {
      sessionKey: state.sessionKey,
      limit: 1000,
      offset: 2,
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.history", {
      sessionKey: state.sessionKey,
      limit: 1000,
      offset: 4,
    });
    expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
  });

  it("abandons reply navigation when the pane switches sessions", async () => {
    const deferred = createDeferred<{
      messages: unknown[];
      hasMore: boolean;
      totalMessages: number;
    }>();
    const request = vi.fn(() => deferred.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
    const revealMessage = vi.spyOn(pane.transcript, "revealMessage");

    pane.openReplyMessage("source-message");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    state.sessionKey = "agent:main:other";
    pane.resetOlderMessagesViewport();
    deferred.resolve({ messages: [], hasMore: false, totalMessages: 4 });
    await deferred.promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
    expect(revealMessage).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it("reports an unavailable reply after history is exhausted", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
      hasMore: false,
      totalMessages: 4,
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };

    pane.openReplyMessage("missing-message");

    await vi.waitFor(() => expect(state.lastError).toBe("The original message is unavailable."));
    expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
  });
});
