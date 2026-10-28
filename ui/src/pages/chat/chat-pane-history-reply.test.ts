/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { createTestChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import { flushDeferredRowPrune } from "./components/chat-transcript.test-support.ts";

const sourceId = "source-message";
const message = { role: "assistant", content: "Original answer", __openclaw: { id: sourceId } };
const pair = (last: number) => [last - 1, last].map((seq) => nativeHistoryMessage(seq));
const page = (messages: unknown[], totalMessages = 4, hasMore = false, nextOffset?: number) => ({
  messages,
  totalMessages,
  hasMore,
  ...(nextOffset === undefined ? {} : { nextOffset }),
});

function fixture(request = vi.fn(), last = 4) {
  const result = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: {} as SessionCapability,
  });
  result.state.chatMessages = pair(last);
  result.state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: last };
  return result;
}

it.each([
  { result: { ok: true, message }, expected: undefined },
  { result: undefined, expected: "pending" },
  { result: { ok: false, unavailableReason: "oversized" }, expected: "oversized" },
  { result: { ok: false, unavailableReason: "not_found" }, expected: "missing" },
])("keeps reply availability through reconnect ($expected)", ({ result, expected }) => {
  const request = vi.fn();
  const { pane, state } = fixture(request);
  state.chatMessages = [
    {
      role: "user",
      content: "Follow-up",
      __openclaw: { replyToId: sourceId, replyToMessage: result },
    },
  ];
  expect(pane.replyMessageStatus(sourceId)).toBe(expected);
  expect(pane.readReplyMessage(sourceId)).toBe(result?.message);
  pane.connectionGeneration += 1;
  state.connectionEpoch = pane.connectionGeneration;
  expect(pane.readReplyMessage(sourceId)).toBe(result?.message);
  expect(state.chatMessages).toHaveLength(1);
  expect(request).not.toHaveBeenCalled();
  state.chatMessages = [];
  expect(pane.readReplyMessage(sourceId)).toBeUndefined();
});

it.each([true, false])(
  "finds paginated replies or reports exhaustion (found: %s)",
  async (found) => {
    const target = {
      ...nativeHistoryMessage(1, "Original answer"),
      __openclaw: { id: sourceId, seq: 1 },
    };
    const request = vi.fn();
    if (found) {
      request.mockResolvedValueOnce(page(pair(4), 6, true, 4));
    }
    request.mockResolvedValueOnce(
      page([found ? target : nativeHistoryMessage(1), nativeHistoryMessage(2)], found ? 6 : 4),
    );
    const { pane, state } = fixture(request, found ? 6 : 4);
    const messageId = found ? sourceId : "missing-message";
    vi.spyOn(pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
    const revealMessage = vi.spyOn(pane.transcript, "revealMessage").mockReturnValue(true);
    pane.openReplyMessage(messageId);
    if (found) {
      expect(pane.currentReplyNavigationId(state.sessionKey)).toBe(sourceId);
      await vi.waitFor(() => expect(revealMessage).toHaveBeenCalledWith(sourceId));
      for (const [index, offset] of [2, 4].entries()) {
        expect(request).toHaveBeenNthCalledWith(
          index + 1,
          "chat.history",
          {
            sessionKey: state.sessionKey,
            limit: 1000,
            maxBytes: 3 * 1024 * 1024,
            toolResultMaxChars: 2_000,
            offset,
          },
          { signal: expect.any(AbortSignal) },
        );
      }
    } else {
      await vi.waitFor(() => expect(state.lastError).toBe("The original message is unavailable."));
      expect(revealMessage).not.toHaveBeenCalled();
    }
    expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
  },
);

it("abandons reply navigation when the pane switches sessions", async () => {
  const deferred = createDeferred<ReturnType<typeof page>>();
  const request = vi.fn(() => deferred.promise);
  const { pane, state } = fixture(request);
  const revealMessage = vi.spyOn(pane.transcript, "revealMessage");
  pane.openReplyMessage(sourceId);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  state.sessionKey = "agent:main:other";
  pane.resetOlderMessagesViewport();
  deferred.resolve(page([]));
  await deferred.promise;
  await flushDeferredRowPrune();
  expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
  expect(revealMessage).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();
});
