/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";

describe("chat pane reply-source history navigation", () => {
  const message = {
    role: "assistant",
    content: "Original answer",
    __openclaw: { id: "source-message" },
  };

  function fixture(request = vi.fn()) {
    return createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: {} as SessionCapability,
    });
  }

  it.each([
    { result: { ok: true, message }, expected: undefined },
    { result: undefined, expected: "pending" },
    { result: { ok: false, unavailableReason: "oversized" }, expected: "oversized" },
    { result: { ok: false, unavailableReason: "not_found" }, expected: "missing" },
  ])(
    "preserves page-carried reply availability across reconnects ($expected)",
    ({ result, expected }) => {
      const request = vi.fn();
      const { pane, state } = fixture(request);
      state.chatMessages = [
        {
          role: "user",
          content: "Follow-up",
          __openclaw: { replyToId: "source-message", replyToMessage: result },
        },
      ];
      expect(pane.replyMessageStatus("source-message")).toBe(expected);
      expect(pane.readReplyMessage("source-message")).toBe(result?.message);
      pane.connectionGeneration += 1;
      state.connectionEpoch = pane.connectionGeneration;
      expect(pane.readReplyMessage("source-message")).toBe(result?.message);
      expect(state.chatMessages).toHaveLength(1);
      expect(request).not.toHaveBeenCalled();
      state.chatMessages = [];
      expect(pane.readReplyMessage("source-message")).toBeUndefined();
    },
  );

  it.each([true, false])(
    "pages backward to a reply or reports exhaustion (found: %s)",
    async (found) => {
      const target = {
        ...nativeHistoryMessage(1, "Original answer"),
        __openclaw: { id: "source-message", seq: 1 },
      };
      const request = vi.fn();
      if (found) {
        request.mockResolvedValueOnce({
          messages: [nativeHistoryMessage(3), nativeHistoryMessage(4)],
          hasMore: true,
          nextOffset: 4,
          totalMessages: 6,
        });
      }
      request.mockResolvedValueOnce({
        messages: [found ? target : nativeHistoryMessage(1), nativeHistoryMessage(2)],
        hasMore: false,
        totalMessages: found ? 6 : 4,
      });
      const { pane, state } = fixture(request);
      state.chatMessages = found
        ? [nativeHistoryMessage(5), nativeHistoryMessage(6)]
        : [nativeHistoryMessage(3), nativeHistoryMessage(4)];
      state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: found ? 6 : 4 };
      const messageId = found ? "source-message" : "missing-message";
      vi.spyOn(pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
      const revealMessage = vi.spyOn(pane.transcript, "revealMessage").mockReturnValue(true);

      pane.openReplyMessage(messageId);

      if (found) {
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
      } else {
        await vi.waitFor(() =>
          expect(state.lastError).toBe("The original message is unavailable."),
        );
        expect(revealMessage).not.toHaveBeenCalled();
      }
      expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
    },
  );

  it("abandons reply navigation when the pane switches sessions", async () => {
    const deferred = createDeferred<{
      messages: unknown[];
      hasMore: boolean;
      totalMessages: number;
    }>();
    const request = vi.fn(() => deferred.promise);
    const { pane, state } = fixture(request);
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
});
