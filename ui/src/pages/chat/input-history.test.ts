/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import {
  createNativeShowEarlierPane,
  nativeHistoryMessage,
  nativeHistorySeq,
} from "./chat-pane-history.test-support.ts";
import { handleChatInputHistoryKey } from "./input-history.ts";

it("refreshes composer recall after leaving a round", async () => {
  const request = vi.fn(async () => ({
    messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
    hasMore: false,
    sessionId: "session-id",
    totalMessages: 4,
  }));
  const { pane, state } = createNativeShowEarlierPane(request);
  state.currentSessionId = "session-id";
  state.chatMessage = "Draft to retain";
  const press = (key: "ArrowUp" | "ArrowDown", caret = 0) =>
    handleChatInputHistoryKey(state, {
      key,
      selectionStart: caret,
      selectionEnd: caret,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 0,
    });

  expect(press("ArrowUp").handled).toBe(true);
  expect(state.chatMessage).toBe("message 3");
  await pane.loadOlderMessages();
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]);
  expect(request).toHaveBeenCalledWith(
    "chat.history",
    expect.objectContaining({
      sessionKey: state.sessionKey,
      limit: 1000,
      cursor: "older-2",
    }),
    { signal: expect.any(AbortSignal) },
  );
  // Loading an older page must not change an active traversal's order.
  expect(press("ArrowUp").handled).toBe(false);
  expect(press("ArrowDown").handled).toBe(true);
  expect(state.chatMessage).toBe("Draft to retain");

  expect(press("ArrowUp").handled).toBe(true);
  expect(state.chatMessage).toBe("message 3");
  expect(press("ArrowUp", 1).handled).toBe(false);
  expect(press("ArrowDown", 1).handled).toBe(false);
  expect(press("ArrowUp").handled).toBe(true);
  expect(state.chatMessage).toBe("message 1");
  expect(press("ArrowDown", state.chatMessage.length).handled).toBe(true);
  expect(state.chatMessage).toBe("message 3");
  expect(press("ArrowDown", state.chatMessage.length).handled).toBe(true);
  expect(state.chatMessage).toBe("Draft to retain");
});
