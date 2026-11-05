/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { restoreChatHistoryBookmark, loadChatHistory } from "./chat-history.ts";
import { nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import { residentPane } from "./chat-pane-resident.test-support.ts";
import { buildMessageItems } from "./chat-thread-items.ts";

afterEach(() => document.body.replaceChildren());

function bookmark(seq = 80) {
  const message = nativeHistoryMessage(seq, `body-${seq}`);
  Object.assign(message["__openclaw"], { id: `source-${seq}` });
  return {
    sessionId: "resident-session",
    source: `id:source-${seq}`,
    messageId: `source-${seq}`,
    messageKey: buildMessageItems([message])[0]!.key,
    rowKey: null,
    offset: -25,
  };
}

it("reopens an evicted bookmark without stitching the missing interval into the tail", async () => {
  const { state, requests } = residentPane();
  await loadChatHistory(state);
  const saved = bookmark();
  expect(state.chatMessages).toHaveLength(80);
  expect(await restoreChatHistoryBookmark(state, saved, () => true)).toBe(true);
  const items = buildMessageItems(state.chatMessages);
  const target = items.findIndex((item) => item.key === saved.messageKey);
  // A short bubble needs following context to restore its saved inner offset.
  expect(items[target + 1]?.key).toBe(bookmark(81).messageKey);
  expect(items.map((item) => item.key)).toEqual(
    Array.from({ length: 80 }, (_, index) => bookmark(index + 41).messageKey),
  );
  expect(requests.at(-1)).toMatchObject({
    messageId: "source-80",
    limit: 80,
    cursor: undefined,
    offset: undefined,
  });
  expect(state.chatHistoryPagination).toMatchObject({
    olderCursor: "before-41",
    newerCursor: "after-120",
    hasNewer: true,
  });
});

it.each(["pane", "physical source", "connection"])(
  "does not admit a held bookmark after its %s changes",
  async (change) => {
    const { state } = residentPane();
    await loadChatHistory(state);
    const held = createDeferred();
    const client = state.client!;
    const request = client.request.bind(client);
    client.request = async (...args) => {
      await held.promise;
      return request(...args);
    };
    let ownsPane = true;
    const restoring = restoreChatHistoryBookmark(state, bookmark(), () => ownsPane);
    if (change === "pane") {
      ownsPane = false;
    } else if (change === "physical source") {
      state.currentSessionId = "replacement-session";
    } else {
      state.connectionEpoch++;
    }
    const retained = state.chatMessages;
    held.resolve();
    expect(await restoring).toBe(false);
    expect(state.chatMessages).toBe(retained);
    expect(state.lastError).toBeNull();
  },
);
