/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { createTestChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import { flushDeferredRowPrune } from "./components/chat-transcript.test-support.ts";

const sourceId = "source-message";
const pair = (last: number) => [last - 1, last].map((seq) => nativeHistoryMessage(seq));
const page = (messages: unknown[]) => ({
  messages,
  totalMessages: 4,
  hasMore: false,
});

function fixture(request = vi.fn()) {
  const result = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: {} as SessionCapability,
  });
  result.state.chatMessages = pair(4);
  result.state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
  return result;
}

it("retains an oversized reply result until its source messages change", () => {
  const request = vi.fn();
  const { pane, state } = fixture(request);
  state.chatMessages = [
    {
      role: "user",
      content: "Follow-up",
      __openclaw: {
        replyToId: sourceId,
        replyToMessage: { ok: false, unavailableReason: "oversized" },
      },
    },
  ];
  expect(pane.replyMessageStatus(sourceId)).toBe("oversized");
  pane.connectionGeneration += 1;
  state.connectionEpoch = pane.connectionGeneration;
  expect(pane.replyMessageStatus(sourceId)).toBe("oversized");
  expect(state.chatMessages).toHaveLength(1);
  expect(request).not.toHaveBeenCalled();
  state.chatMessages = [];
  expect(pane.replyMessageStatus(sourceId)).toBe("pending");
  expect(pane.readReplyMessage(sourceId)).toBeUndefined();
});

it("reports reply exhaustion without revealing another message", async () => {
  const request = vi.fn().mockResolvedValueOnce(page(pair(2)));
  const { pane, state } = fixture(request);
  const revealMessage = vi.spyOn(pane.transcript, "revealMessage");
  pane.openReplyMessage("missing-message");
  await vi.waitFor(() => expect(state.lastError).toBe("The original message is unavailable."));
  expect(revealMessage).not.toHaveBeenCalled();
  expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
});

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
