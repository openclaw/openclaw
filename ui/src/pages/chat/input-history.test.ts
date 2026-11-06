/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import {
  createNativeShowEarlierPane,
  nativeHistoryMessage,
  nativeHistorySeq,
} from "./chat-pane-history.test-support.ts";
import { handleChatInputHistoryKey, type ChatInputHistoryState } from "./input-history.ts";

it("caps recall at 100 user inputs rather than assistant and tool activity", () => {
  const state: ChatInputHistoryState = {
    sessionKey: "main",
    chatLoading: false,
    chatMessage: "Reserved draft",
    chatMessages: [],
    chatLocalInputHistoryBySession: {},
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
  };
  state.chatMessages = Array.from({ length: 101 }, (_, index) => [
    { role: "user", content: `Prompt ${index + 1}`, timestamp: index * 3 },
    { role: "assistant", content: "Checking", timestamp: index * 3 + 1 },
    { role: "toolResult", content: "Done", timestamp: index * 3 + 2 },
  ]).flat();
  const press = (key: "ArrowUp" | "ArrowDown") =>
    handleChatInputHistoryKey(state, {
      key,
      selectionStart: 0,
      selectionEnd: 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 0,
    });
  const recalled: string[] = [];
  for (let index = 0; index < 100; index++) {
    expect(press("ArrowUp").handled).toBe(true);
    recalled.push(state.chatMessage);
  }
  expect(press("ArrowUp").handled).toBe(false);
  expect(recalled).toEqual(Array.from({ length: 100 }, (_, index) => `Prompt ${101 - index}`));
  for (let index = 0; index < 100; index++) {
    expect(press("ArrowDown").handled).toBe(true);
  }
  expect(state.chatMessage).toBe("Reserved draft");
});

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
