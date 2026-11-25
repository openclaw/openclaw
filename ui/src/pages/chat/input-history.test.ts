/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createNativeShowEarlierPane,
  nativeHistoryMessage,
  nativeHistorySeq,
} from "./chat-pane-history.test-support.ts";
import { handleChatDraftChange, handleChatInputHistoryKey } from "./input-history.ts";

it("bounds recall by users and does not skip prompts prepended during a round", async () => {
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
  const rendered = state.chatMessages;
  expect(press("ArrowUp").handled).toBe(true);
  expect(state.chatMessage).toBe("message 201");
  expect(state.chatMessages).toBe(rendered);
  expect(press("ArrowDown").handled).toBe(true);
  expect(state.chatMessage).toBe("message 203");
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

it.each(["missing", "repeated", "reset"] as const)(
  "reopens the held boundary after a %s continuation without publishing a page",
  async (cursor) => {
    const request = vi.fn().mockResolvedValueOnce({
      messages: [nativeHistoryMessage(201)],
      hasMore: true,
      sessionId: "session-id",
      ...(cursor === "reset" ? { windowReset: true, olderCursor: "invalidated-edge" } : {}),
      ...(cursor === "repeated" ? { olderCursor: "older-2" } : {}),
    });
    const { state } = createNativeShowEarlierPane(request, 203);
    state.currentSessionId = "session-id";
    state.chatMessage = "Current draft";
    state.chatHistoryPagination = { hasMore: true, olderCursor: "older-2" };
    const anchor = { ...nativeHistoryMessage(203), __openclaw: { seq: 203, id: "anchor" } };
    state.chatMessages = [anchor, nativeHistoryMessage(204)];
    const rendered = state.chatMessages;
    const originalMessages = [...rendered];

    state.handleChatInputHistoryKey(recallKey("ArrowUp"));
    expect(state.chatMessage).toBe("message 203");
    const pending = state.handleChatInputHistoryKey(recallKey("ArrowUp"));
    expect(await pending.completion).toMatchObject({ handled: false });

    expect(state.chatError).toBeTruthy();
    expect(state.chatMessage).toBe("message 203");
    expect(request).toHaveBeenCalledTimes(1);
    request
      .mockResolvedValueOnce({
        messages: [anchor],
        sessionId: "session-id",
        olderCursor: "reopened",
      })
      .mockResolvedValueOnce({ messages: [nativeHistoryMessage(199)], sessionId: "session-id" });
    await state.handleChatInputHistoryKey(recallKey("ArrowUp")).completion;
    expect(
      request.mock.calls.slice(1).map(([, params]) => params.cursor ?? params.messageId),
    ).toEqual(["anchor", "reopened"]);
    expect(state.chatMessage).toBe("message 199");
    expect(state.chatError).toBeFalsy();
    expect(state.chatMessages).toBe(rendered);
    expect(state.chatMessages).toEqual(originalMessages);
  },
);

it("clears a recall error when a new traversal successfully retries", async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error("History unavailable"))
    .mockResolvedValueOnce({ messages: [nativeHistoryMessage(201)] });
  const { state } = createNativeShowEarlierPane(request, 203);
  const press = (key: "ArrowUp" | "ArrowDown") => state.handleChatInputHistoryKey(recallKey(key));
  press("ArrowUp");
  await press("ArrowUp").completion;
  expect(state.chatError).toBe("History unavailable");
  press("ArrowDown");
  press("ArrowUp");
  await press("ArrowUp").completion;
  expect(state.chatMessage).toBe("message 201");
  expect(state.chatError).toBeFalsy();
});

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
    expect(request).toHaveBeenCalledTimes(2);
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
  const readerFactory = vi.fn(() => ({ read, isCurrent: () => true }));
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

it("yields after three sparse pages and resumes from the next cursor on another Up", async () => {
  const cursors: string[] = [];
  const request = vi.fn(async (_method: string, { cursor }: { cursor: string }) => {
    cursors.push(cursor);
    const index = ["older-2", "page-2", "page-3", "page-4"].indexOf(cursor);
    if (index < 0) {
      throw new Error("Unexpected cursor");
    }
    return index === 3
      ? { messages: [nativeHistoryMessage(201)], hasMore: false }
      : { messages: [nativeHistoryMessage(202)], olderCursor: "page-" + (index + 2) };
  });
  const { state } = createNativeShowEarlierPane(request, 203);
  // No user prompt in the loaded window. Hitting the budget still retains progress.
  state.chatMessages = [nativeHistoryMessage(204)];
  const transcript = state.chatMessages;
  state.chatMessage = "Draft to retain";
  const up = () => state.handleChatInputHistoryKey(recallKey("ArrowUp"));
  await up().completion;
  expect(cursors).toEqual(["older-2", "page-2", "page-3"]);
  expect(state.chatMessage).toBe("Draft to retain");
  await up().completion;
  expect(cursors).toEqual(["older-2", "page-2", "page-3", "page-4"]);
  expect(state.chatMessage).toBe("message 201");
  state.handleChatInputHistoryKey(recallKey("ArrowDown"));
  expect(state.chatMessage).toBe("Draft to retain");
  expect(state.chatMessages).toBe(transcript);
});

it("joins repeated Up presses to one pending read without skipping a message", async () => {
  const { state } = createNativeShowEarlierPane(vi.fn(), 203);
  const page = createDeferred<{ messages: unknown[]; hasMore: boolean }>();
  const read = vi.fn(() => page.promise);
  const readerFactory = vi.fn(() => ({ read, isCurrent: () => true }));
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

it.each(["down", "down in text", "edit", "replace edge"] as const)(
  "ignores late pages and errors after %s cancels an older read",
  async (action) => {
    for (const reject of [false, true]) {
      const page = createDeferred<{ messages: unknown[]; olderCursor: string }>();
      const request = vi
        .fn()
        .mockReturnValueOnce(page.promise)
        .mockResolvedValue({
          messages: [nativeHistoryMessage(201)],
          hasMore: false,
        });
      const { state } = createNativeShowEarlierPane(request, 203);
      const transcript = state.chatMessages;
      const mentions = [{ profileId: "alex", start: 0, end: 5 }];
      state.chatMessage = "@alex Draft to retain";
      state.chatMentions = mentions;
      const press = (key: "ArrowUp" | "ArrowDown") =>
        state.handleChatInputHistoryKey(recallKey(key));
      press("ArrowUp");
      const pending = press("ArrowUp");
      expect(request).toHaveBeenCalledTimes(1);
      if (action === "edit") {
        handleChatDraftChange(state, "Edited draft");
      } else if (action === "down") {
        press("ArrowDown");
      } else if (action === "down in text") {
        expect(state.handleChatInputHistoryKey(recallKey("ArrowDown", 3)).handled).toBe(false);
      } else {
        state.chatHistoryPagination = { hasMore: true, olderCursor: "replacement" };
      }
      if (reject) {
        page.reject(new Error("Obsolete read"));
      } else {
        page.resolve({ messages: [nativeHistoryMessage(202)], olderCursor: "obsolete" });
      }
      await pending.completion;
      expect(request).toHaveBeenCalledTimes(1);
      expect(state.chatError).toBeFalsy();
      if (action === "down in text") {
        expect(state.chatMessage).toBe("message 203");
        press("ArrowDown");
      }
      if (action === "replace edge") {
        expect(state.chatMessage).toBe("message 203");
        await press("ArrowUp").completion;
        expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: "replacement" });
        expect(state.chatMessage).toBe("message 201");
        press("ArrowDown");
        press("ArrowDown");
      }
      expect(state.chatMessage).toBe(action === "edit" ? "Edited draft" : "@alex Draft to retain");
      if (action !== "edit") {
        expect(state.chatMentions).toEqual(mentions);
      }
      expect(state.chatMessages).toBe(transcript);
    }
  },
);
