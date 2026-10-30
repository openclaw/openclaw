/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "./chat-pane.tsx";
import { loadChatHistory } from "./chat-history.ts";
import {
  appendChatThread,
  createTestChatPane,
  nativeHistoryMessage,
  nativeHistorySeq,
} from "./chat-pane-history.test-support.ts";
import { applyChatCacheSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";
import { createSnapshotRecord, parseSnapshotRecord } from "./session-snapshot-record.ts";

type Selector = { cursor?: string; offset?: number; messageId?: string; limit?: number };

function sourceMessage(seq: number) {
  const message = nativeHistoryMessage(seq);
  return { ...message, __openclaw: { ...message["__openclaw"], id: `source-${seq}` } };
}

function page(seqs: number[], olderCursor?: string) {
  return {
    messages: seqs.map(sourceMessage),
    sessionId: "physical-session",
    ...(olderCursor ? { olderCursor } : {}),
  };
}

function tail(seqs: number[], olderCursor: string, totalMessages: number, nextOffset: number) {
  return { ...page(seqs, olderCursor), hasMore: true, totalMessages, nextOffset };
}

function historyPane(read: (selector: Selector) => unknown) {
  const request = vi.fn(async (_method: string, selector: Selector) => read(selector));
  const result = createTestChatPane({ client: { request } as unknown as GatewayBrowserClient });
  appendChatThread(result.pane);
  vi.spyOn(result.pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
  return { ...result, request };
}

const sequences = (messages: unknown[]) => messages.map(nativeHistorySeq);

it("continues before the admitted tail boundary after new source groups append", async () => {
  let appended = false;
  const { pane, state, request } = historyPane(({ cursor, offset }) =>
    cursor === "older-A"
      ? page([1, 2])
      : appended
        ? tail(offset === 2 ? [5, 6] : [7, 8], "moved-edge", 8, offset === 2 ? 4 : 2)
        : tail([3, 4], "older-A", 4, 2),
  );
  await loadChatHistory(state, { deferBranches: true });
  const held = [...state.chatMessages];
  appended = true;

  await pane.loadOlderMessages();

  expect(request.mock.calls[1]).toEqual([
    "chat.history",
    expect.objectContaining({ cursor: "older-A" }),
    { signal: expect.any(AbortSignal) },
  ]);
  expect(request.mock.calls[1]![1]).not.toHaveProperty("offset");
  expect(sequences(state.chatMessages)).toEqual([1, 2, 3, 4]);
  expect(state.chatMessages.slice(-2)).toEqual(held);
});

it("keeps the aggregate oldest edge across a staged page and an appended tail refresh", async () => {
  let refreshed = false;
  const { pane, state, request } = historyPane(({ cursor }) => {
    if (cursor === "older-A") {
      return page([3, 4], "older-B");
    }
    if (cursor === "older-B") {
      return page([1, 2]);
    }
    return refreshed ? tail([7, 8, 9], "tail-edge", 9, 3) : tail([5, 6, 7, 8], "older-A", 8, 4);
  });
  await loadChatHistory(state, { deferBranches: true });
  await pane.loadOlderMessages();
  await vi.waitFor(() => expect(pane.stagedOlder.load).toBeNull());
  refreshed = true;
  await loadChatHistory(state, { deferBranches: true });

  await pane.loadOlderMessages();

  expect(sequences(state.chatMessages)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(request.mock.calls.some(([, selector]) => selector.cursor === "tail-edge")).toBe(false);
  expect(request.mock.calls.some(([, selector]) => selector.cursor === "older-B")).toBe(true);
});

it("publishes edge-only progress and crosses an overlap-only page in the same reader action", async () => {
  const { pane, state, request } = historyPane(({ cursor }) => {
    if (cursor === "older-A") {
      return page([3], "older-B");
    }
    if (cursor === "older-B") {
      return page([1, 2]);
    }
    return tail([3, 4], "older-A", 4, 2);
  });
  await loadChatHistory(state, { deferBranches: true });

  await pane.loadOlderMessages();

  expect(request.mock.calls.slice(1).map(([, selector]) => selector.cursor)).toEqual([
    "older-A",
    "older-B",
  ]);
  expect(sequences(state.chatMessages)).toEqual([1, 2, 3, 4]);
  expect(state.chatHistoryPagination.hasMore).toBe(false);
  expect(
    readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey: state.sessionKey })
      ?.messages,
  ).toEqual(state.chatMessages);
});

it("hands an empty cursor reset to authoritative history instead of adopting an empty snapshot", async () => {
  let tails = 0;
  const { pane, state, request } = historyPane(({ cursor, offset }) => {
    if (cursor || offset !== undefined) {
      return { messages: [], windowReset: true };
    }
    return ++tails === 1
      ? { ...tail([3, 4], "older-A", 4, 2), deltaCursor: "retired-delta" }
      : page([7, 8]);
  });
  await loadChatHistory(state, { deferBranches: true });

  await pane.loadOlderMessages();

  expect(sequences(state.chatMessages)).toEqual([7, 8]);
  expect(request.mock.calls).toHaveLength(3);
  expect(request.mock.calls[2]![1]).not.toHaveProperty("cursor");
  expect(request.mock.calls[2]![1]).not.toHaveProperty("offset");
  expect(pane.stagedOlder.page).toBeNull();
});

it("reopens a disk-trimmed held boundary after tail refresh without skipping discarded rows", async () => {
  const { pane, state, request } = historyPane(({ messageId, cursor }) => {
    if (messageId === "source-23") {
      return page([23], "before-held-boundary");
    }
    if (cursor === "before-held-boundary") {
      return page(Array.from({ length: 22 }, (_, index) => index + 1));
    }
    return tail([103, 104], "fresh-tail-edge", 104, 2);
  });
  const prepared = await createSnapshotRecord(state.sessionKey, {
    savedAt: 1,
    snapshot: {
      messages: Array.from({ length: 102 }, (_, index) => sourceMessage(index + 1)),
      sessionId: "physical-session",
      pagination: { hasMore: false, totalMessages: 102 },
    },
  });
  const restored = await parseSnapshotRecord(prepared!.record, state.sessionKey);
  expect(restored).not.toBeNull();
  applyChatCacheSnapshot(state, restored!.snapshot);
  const held = [...state.chatMessages];
  expect(sequences(held)).toEqual(Array.from({ length: 80 }, (_, index) => index + 23));
  await loadChatHistory(state, { deferBranches: true });
  expect(state.chatMessages.slice(0, 80)).toEqual(held);

  await pane.loadOlderMessages();

  expect(request.mock.calls[1]![1]).toMatchObject({ messageId: "source-23", limit: 1 });
  expect(request.mock.calls.slice(1).every(([, selector]) => selector.offset === undefined)).toBe(
    true,
  );
  expect(request.mock.calls.some(([, selector]) => selector.cursor === "fresh-tail-edge")).toBe(
    false,
  );
  expect(sequences(state.chatMessages)).toEqual(
    Array.from({ length: 104 }, (_, index) => index + 1),
  );
  for (let index = 0; index < held.length; index++) {
    expect(state.chatMessages[index + 22]).toBe(held[index]);
  }
});
