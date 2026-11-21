/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createNativeShowEarlierPane,
  nativeHistoryMessage,
  nativeHistorySeq,
} from "./chat-pane-history.test-support.ts";
import { handleChatDraftChange, handleChatInputHistoryKey } from "./input-history.ts";

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

it("consumes a boundary probe without recalling probe rows or mutating rendered history", async () => {
  const anchor = {
    ...nativeHistoryMessage(203),
    __openclaw: { seq: 203, id: "recall-203" },
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      messages: [
        {
          ...anchor,
          content: [{ type: "text", text: "Probe context must not enter recall" }],
        },
      ],
      hasMore: true,
      olderCursor: "reopened",
      sessionId: "session-id",
    })
    .mockResolvedValueOnce({
      messages: [nativeHistoryMessage(201)],
      hasMore: false,
      sessionId: "session-id",
    });
  const { state } = createNativeShowEarlierPane(request, 203);
  state.currentSessionId = "session-id";
  state.chatMessage = "Current draft";
  state.chatMessages = [anchor, nativeHistoryMessage(204)];
  state.chatHistoryPagination = { hasMore: true, needsBoundary: true };
  const rendered = state.chatMessages;
  const originalMessages = [...rendered];
  const pagination = state.chatHistoryPagination;

  state.handleChatInputHistoryKey(recallKey("ArrowUp"));
  expect(state.chatMessage).toBe("message 203");
  const pending = state.handleChatInputHistoryKey(recallKey("ArrowUp"));
  expect(pending).toMatchObject({
    handled: true,
    preventDefault: true,
    restoreCaret: null,
  });
  expect(await pending.completion).toMatchObject({ handled: true });

  expect(state.chatMessage).toBe("message 201");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0]?.[0]).toBe("chat.history");
  expect(request.mock.calls[0]?.[1]).toMatchObject({ messageId: "recall-203" });
  expect(request.mock.calls[1]?.[0]).toBe("chat.history");
  expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: "reopened" });
  expect(state.chatMessages).toBe(rendered);
  expect(state.chatMessages).toEqual(originalMessages);
  expect(state.chatHistoryPagination).toBe(pagination);
});

it.each(["missing", "repeated"] as const)(
  "rejects a %s continuation cursor without replacing the recalled draft",
  async (cursor) => {
    const request = vi.fn().mockResolvedValueOnce({
      messages: [nativeHistoryMessage(201)],
      hasMore: true,
      sessionId: "session-id",
      ...(cursor === "repeated" ? { olderCursor: "older-2" } : {}),
    });
    const { state } = createNativeShowEarlierPane(request, 203);
    state.currentSessionId = "session-id";
    state.chatMessage = "Current draft";
    state.chatHistoryPagination = { hasMore: true, olderCursor: "older-2" };
    const rendered = state.chatMessages;
    const originalMessages = [...rendered];

    state.handleChatInputHistoryKey(recallKey("ArrowUp"));
    expect(state.chatMessage).toBe("message 203");
    const pending = state.handleChatInputHistoryKey(recallKey("ArrowUp"));
    expect(await pending.completion).toMatchObject({ handled: false });

    expect(state.chatError).toBeTruthy();
    expect(state.chatMessage).toBe("message 203");
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatMessages).toBe(rendered);
    expect(state.chatMessages).toEqual(originalMessages);
  },
);

it.each(["connection", "session"] as const)(
  "ignores a pending history page after the %s scope changes",
  async (scope) => {
    const page = createDeferred<{
      messages: unknown[];
      hasMore: boolean;
      sessionId: string;
    }>();
    const request = vi.fn().mockReturnValueOnce(page.promise);
    const { state } = createNativeShowEarlierPane(request, 203);
    state.currentSessionId = "session-id";
    state.chatMessage = "Current draft";
    const rendered = state.chatMessages;
    const originalMessages = [...rendered];

    state.handleChatInputHistoryKey(recallKey("ArrowUp"));
    expect(state.chatMessage).toBe("message 203");
    const pending = state.handleChatInputHistoryKey(recallKey("ArrowUp"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    if (scope === "connection") {
      state.connectionEpoch = (state.connectionEpoch ?? 0) + 1;
    } else {
      state.sessionKey = "agent:main:other";
      state.chatMessage = "Other draft";
    }
    page.resolve({
      messages: [nativeHistoryMessage(201)],
      hasMore: false,
      sessionId: "session-id",
    });
    expect(await pending.completion).toMatchObject({ handled: false });

    expect(state.chatMessage).toBe(scope === "session" ? "Other draft" : "message 203");
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatMessages).toBe(rendered);
    expect(state.chatMessages).toEqual(originalMessages);
  },
);

it.each(["reconnect", "navigate"] as const)(
  "preserves the saved draft and later recall after %s interrupts pending Up",
  async (action) => {
    const page = createDeferred<{
      messages: unknown[];
      hasMore: boolean;
      sessionId: string;
    }>();
    const older = {
      messages: [nativeHistoryMessage(201)],
      hasMore: false,
      sessionId: "session-id",
    };
    const request = vi.fn().mockReturnValueOnce(page.promise).mockResolvedValue(older);
    const { state } = createNativeShowEarlierPane(request, 203);
    state.currentSessionId = "session-id";
    state.chatMessage = "Saved draft";
    const press = (key: "ArrowUp" | "ArrowDown") =>
      state.handleChatInputHistoryKey(
        recallKey(key, key === "ArrowDown" ? state.chatMessage.length : 0),
      );

    press("ArrowUp");
    const pending = press("ArrowUp");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    if (action === "reconnect") {
      state.connectionEpoch = (state.connectionEpoch ?? 0) + 1;
    } else {
      press("ArrowDown");
      expect(state.chatMessage).toBe("Saved draft");
      press("ArrowUp");
    }
    page.resolve(older);
    expect(await pending.completion).toMatchObject({ handled: false });
    expect(state.chatMessage).toBe("message 203");

    const next = press("ArrowUp");
    if (next.completion) {
      expect(await next.completion).toMatchObject({ handled: true });
    }
    expect(state.chatMessage).toBe("message 201");
    expect(request).toHaveBeenCalledTimes(action === "reconnect" ? 2 : 1);
    press("ArrowDown");
    press("ArrowDown");
    expect(state.chatMessage).toBe("Saved draft");
  },
);

const recallKey = (key: "ArrowUp" | "ArrowDown", caret = 0) => ({
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

it("recalls unloaded messages without loading the transcript and restores draft mentions", async () => {
  const { state } = createNativeShowEarlierPane(vi.fn(), 203);
  state.currentSessionId = "session-id";
  state.chatMessage = "@alex Draft to retain";
  state.chatMentions = [{ profileId: "alex", start: 0, end: 5 }];
  const transcript = state.chatMessages;
  const read = vi.fn(async () => ({
    messages: [201, 202].map((seq) => nativeHistoryMessage(seq)),
    hasMore: false,
  }));
  const readerFactory = vi.fn(() => read);
  const press = (key: "ArrowUp" | "ArrowDown") =>
    handleChatInputHistoryKey(
      state,
      recallKey(key, key === "ArrowDown" ? state.chatMessage.length : 0),
      readerFactory,
    );

  expect(press("ArrowUp").handled).toBe(true);
  expect(state.chatMessage).toBe("message 203");
  const pending = press("ArrowUp");
  expect(pending.handled).toBe(true);
  expect(pending.preventDefault).toBe(true);
  expect(pending.completion).toBeDefined();
  await expect(pending.completion).resolves.toMatchObject({ handled: true });
  expect(state.chatMessage).toBe("message 201");
  expect(state.chatMessages).toBe(transcript);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([203, 204]);
  expect(readerFactory).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);

  expect(press("ArrowDown").handled).toBe(true);
  expect(state.chatMessage).toBe("message 203");
  expect(press("ArrowDown").handled).toBe(true);
  expect(state.chatMessage).toBe("@alex Draft to retain");
  expect(state.chatMentions).toEqual([{ profileId: "alex", start: 0, end: 5 }]);
  expect(state.chatMessages).toBe(transcript);
});

it("continues past sparse and duplicate pages to the next older user message", async () => {
  const { state } = createNativeShowEarlierPane(vi.fn(), 203);
  const read = vi
    .fn<() => Promise<{ messages?: unknown[]; hasMore: boolean }>>()
    .mockResolvedValueOnce({ hasMore: true })
    .mockResolvedValueOnce({
      messages: [202, 203, 204].map((seq) => nativeHistoryMessage(seq)),
      hasMore: true,
    })
    .mockResolvedValueOnce({
      messages: [199, 200, 201].map((seq) => nativeHistoryMessage(seq)),
      hasMore: false,
    });
  const readerFactory = vi.fn(() => read);
  const press = () => handleChatInputHistoryKey(state, recallKey("ArrowUp"), readerFactory);

  expect(press().handled).toBe(true);
  const pending = press();
  expect(pending.completion).toBeDefined();
  await expect(pending.completion).resolves.toMatchObject({ handled: true });
  expect(state.chatMessage).toBe("message 201");
  expect(read).toHaveBeenCalledTimes(3);
  expect(readerFactory).toHaveBeenCalledTimes(1);
  expect(press().handled).toBe(true);
  expect(state.chatMessage).toBe("message 199");
  expect(read).toHaveBeenCalledTimes(3);
});

it("joins repeated Up presses to one pending read without skipping a message", async () => {
  const { state } = createNativeShowEarlierPane(vi.fn(), 203);
  const page = createDeferred<{ messages: unknown[]; hasMore: boolean }>();
  const read = vi.fn(() => page.promise);
  const readerFactory = vi.fn(() => read);
  const press = () => handleChatInputHistoryKey(state, recallKey("ArrowUp"), readerFactory);

  expect(press().handled).toBe(true);
  const pending = press();
  const repeated = press();
  expect(pending.completion).toBeDefined();
  expect(repeated.completion).toBe(pending.completion);
  expect(read).toHaveBeenCalledTimes(1);
  expect(readerFactory).toHaveBeenCalledTimes(1);
  expect(state.chatMessage).toBe("message 203");

  page.resolve({
    messages: [199, 200, 201, 202].map((seq) => nativeHistoryMessage(seq)),
    hasMore: false,
  });
  await Promise.all([pending.completion, repeated.completion]);
  expect(state.chatMessage).toBe("message 201");
  expect(read).toHaveBeenCalledTimes(1);
});

it.each(["edit", "down"] as const)(
  "does not overwrite the draft when %s cancels pending recall",
  async (action) => {
    const { state } = createNativeShowEarlierPane(vi.fn(), 203);
    state.chatMessage = "@alex Draft to retain";
    state.chatMentions = [{ profileId: "alex", start: 0, end: 5 }];
    const transcript = state.chatMessages;
    const page = createDeferred<{ messages: unknown[]; hasMore: boolean }>();
    const read = vi.fn(() => page.promise);
    const readerFactory = vi.fn(() => read);
    const press = (key: "ArrowUp" | "ArrowDown") =>
      handleChatInputHistoryKey(
        state,
        recallKey(key, key === "ArrowDown" ? state.chatMessage.length : 0),
        readerFactory,
      );

    expect(press("ArrowUp").handled).toBe(true);
    const pending = press("ArrowUp");
    expect(pending.completion).toBeDefined();
    expect(read).toHaveBeenCalledTimes(1);
    if (action === "edit") {
      handleChatDraftChange(state, "Edited draft");
    } else {
      expect(press("ArrowDown").handled).toBe(true);
    }
    const expectedDraft = action === "edit" ? "Edited draft" : "@alex Draft to retain";
    expect(state.chatMessage).toBe(expectedDraft);
    page.resolve({
      messages: [201, 202].map((seq) => nativeHistoryMessage(seq)),
      hasMore: false,
    });
    await pending.completion;
    expect(state.chatMessage).toBe(expectedDraft);
    expect(state.chatMessages).toBe(transcript);
    if (action === "down") {
      expect(state.chatMentions).toEqual([{ profileId: "alex", start: 0, end: 5 }]);
    }
  },
);
