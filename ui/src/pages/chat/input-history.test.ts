/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import {
  createNativeShowEarlierPane,
  nativeHistoryMessage,
  nativeHistorySeq,
} from "./chat-pane-history.test-support.ts";
import { handleChatInputHistoryKey } from "./input-history.ts";

it("bounds recall by users and refreshes only after leaving a round", async () => {
  const seqs = Array.from({ length: 204 }, (_, i) => i + 1);
  const request = vi.fn(async () => ({
    messages: seqs.slice(0, -2).map((seq) => nativeHistoryMessage(seq)),
    hasMore: false,
    sessionId: "session-id",
    totalMessages: seqs.length,
  }));
  const { pane, state } = createNativeShowEarlierPane(request, 203);
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
  expect(state.chatMessage).toBe("message 203");
  await pane.loadOlderMessages();
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual(seqs);
  const pageRequest = { sessionKey: state.sessionKey, limit: 1000, cursor: "older-2" };
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "chat.history",
    expect.objectContaining(pageRequest),
    { signal: expect.any(AbortSignal) },
  );
  // Loading an older page must not change an active traversal's order.
  expect(press("ArrowUp").handled).toBe(false);
  expect(press("ArrowDown").handled).toBe(true);
  expect(state.chatMessage).toBe("Draft to retain");

  for (let seq = 203; seq >= 5; seq -= 2) {
    expect(press("ArrowUp").handled).toBe(true);
    expect(state.chatMessage).toBe(`message ${seq}`);
  }
  expect(press("ArrowUp").handled).toBe(false);
  expect(press("ArrowDown", state.chatMessage.length).handled).toBe(true);
  expect(press("ArrowUp", 1).handled).toBe(false);
  expect(press("ArrowDown", 1).handled).toBe(false);
  for (let index = 0; index < 99; index++) {
    expect(press("ArrowDown", state.chatMessage.length).handled).toBe(true);
  }
  expect(state.chatMessage).toBe("Draft to retain");
});
