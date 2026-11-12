/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import "./chat-pane.tsx";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { prepareChatHistoryPacket } from "./chat-history-window.ts";
import { admitChatHistoryPages } from "./chat-pane-history-packets.runtime.ts";
import {
  createStagedPrefetchPane,
  createTestChatPane,
  historyPage,
  nativeHistoryMessage,
  nativeHistorySeq,
  expectNativeHistoryRange,
  pagination,
  sparsePrefetchRequest,
  stagedPagesRequest,
} from "./chat-pane-history.test-support.ts";
import { readChatInputRunIds } from "./chat-pending-inputs.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjection,
  reduceChatSessionProjection,
} from "./history-merge.ts";

function packetHistoryPane(total = 480) {
  const packet = (start: number, end: number): ChatHistoryResult => ({
    messages: Array.from({ length: end - start + 1 }, (_, index) =>
      nativeHistoryMessage(start + index),
    ),
    hasMore: start > 1,
    ...(start > 1 ? { olderCursor: `older-${start - 1}` } : {}),
    ...(end < total ? { newerCursor: `newer-${end + 1}` } : {}),
    totalMessages: total,
  });
  const request = vi.fn(async (_method: string, params: { cursor: string }) => {
    const [direction, raw] = params.cursor.split("-");
    const edge = Number(raw);
    return direction === "older"
      ? packet(Math.max(1, edge - 79), edge)
      : packet(edge, Math.min(total, edge + 79));
  });
  const { pane, state } = createTestChatPane({
    client: { request } as unknown as GatewayBrowserClient,
  });
  admitChatHistoryPages(state, [packet(total - 79, total)], "around");
  let reader = `seq:${total - 40}`;
  state.readTranscriptReaderSnapshot = () => ({
    anchor: reader,
    visibleSources: reader ? [reader] : [],
  });
  return {
    pane,
    state,
    request,
    moveReader: (seq: number) => {
      reader = `seq:${seq}`;
    },
  };
}

function pendingInput(
  state: Parameters<typeof reduceChatSessionProjection>[0],
  runId: string,
  content: string,
) {
  reduceChatSessionProjection(state, {
    type: "sendPending",
    runId,
    message: { role: "user", content, __openclaw: { idempotencyKey: `${runId}:user` } },
  });
  return {
    persisted: (seq: number) =>
      Object.assign(nativeHistoryMessage(seq, content), {
        __openclaw: { seq, idempotencyKey: `${runId}:user` },
      }),
    pending: () =>
      getChatSessionProjection(state).entries.some(
        (entry) => entry.pending && entry.pendingRunId === runId,
      ),
  };
}

function fragmentedSource(seq: number, keyed = false) {
  return Array.from({ length: 401 }, (_, fragment) =>
    Object.assign(nativeHistoryMessage(seq, `fragment-${fragment}`), {
      __openclaw: { seq, ...(keyed ? { id: `source-${seq}` } : {}) },
    }),
  );
}

it("admits a contiguous packet chain in one foreground publication", async () => {
  const held = createDeferred<ChatHistoryResult>();
  const request = stagedPagesRequest({
    4: () => held.promise,
  });
  const { pane, state } = createStagedPrefetchPane(request);
  const published = vi.spyOn(state, "chatMessages", "set");
  const loading = pane.loadOlderMessages();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  // The second wire reply belongs to this admission, not a second render.
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([7, 8]);
  held.resolve(historyPage([3, 4], { ...pagination(8, 6), newerCursor: "newer-4" }));
  await expect(loading).resolves.toBe(true);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(request).toHaveBeenCalledTimes(3);
  expect(published).toHaveBeenCalledTimes(1);
  expect(state.chatHistoryPagination.hasMore).toBe(false);
  expect(state.chatHistoryPagination.segments).toHaveLength(4);
});

it("publishes a valid packet prefix while exposing a later foreground failure", async () => {
  const request = stagedPagesRequest({
    4: () => Promise.reject(new Error("second packet failed")),
  });
  const { pane, state } = createStagedPrefetchPane(request);
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([5, 6, 7, 8]);
  expect(pane.history.olderError).toContain("second packet failed");
  expect(state.chatHistoryPagination).toMatchObject({ hasMore: true, olderCursor: "older-4" });
  expect(request).toHaveBeenCalledTimes(2);
});

it("settles a filled chain and reverses through its opaque edge without source IDs", async () => {
  const { pane, state, request, moveReader } = packetHistoryPane();
  readChatInputRunIds(state);
  const published = vi.spyOn(state, "chatMessages", "set");
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(published).toHaveBeenCalledTimes(1);
  expectNativeHistoryRange(state.chatMessages, 81, 400);
  expect(request.mock.calls.map(([, params]) => params.cursor)).toEqual([
    "older-400",
    "older-320",
    "older-240",
    "older-160",
  ]);
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(4);
  expect(pane.stagedHistory.page).toBeNull();
  expect(pane.stagedHistory.load).toBeNull();
  moveReader(81);
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(request).toHaveBeenCalledTimes(5);
  expectNativeHistoryRange(state.chatMessages, 1, 400);
  expect(state.chatHistoryPagination).toMatchObject({
    hasMore: false,
    hasNewer: true,
    newerCursor: "newer-401",
  });
  moveReader(400);
  await expect(pane.loadNewerMessages()).resolves.toBe(true);
  expect(request.mock.calls.at(-1)?.[1].cursor).toBe("newer-401");
  expectNativeHistoryRange(state.chatMessages, 81, 400);
  expect(state.chatHistoryPagination.hasNewer).toBeUndefined();
  expect(pane.stagedHistory.page).toBeNull();
  const wireBytes = (first: number, count: number) =>
    JSON.stringify(Array.from({ length: count }, (_, index) => nativeHistoryMessage(first + index)))
      .length;
  expect(request.mock.calls.map(([, params]) => params)).toEqual([
    ...[40, 120, 200, 280].map((count) => ({
      sessionKey: state.sessionKey,
      toolResultMaxChars: 2_000,
      cursor: `older-${440 - count}`,
      limit: 400 - count,
      maxBytes: 3 * 1024 * 1024 - wireBytes(441 - count, count),
    })),
    expect.objectContaining({
      cursor: "older-80",
      limit: 320,
      maxBytes: 3 * 1024 * 1024 - wireBytes(81, 80),
    }),
    expect.objectContaining({
      cursor: "newer-401",
      limit: 320,
      maxBytes: 3 * 1024 * 1024 - wireBytes(321, 80),
    }),
  ]);
  for (const [, params] of request.mock.calls) {
    expect(params).not.toHaveProperty("messageId");
  }
});

it("revalidates the reader bridge before admission and stages its earliest unadmitted packet", async () => {
  const { pane, state, request, moveReader } = packetHistoryPane(640);
  const held = createDeferred<ChatHistoryResult>();
  const base = request.getMockImplementation()!;
  request.mockImplementation((method, params) =>
    params.cursor === "older-160" ? held.promise : base(method, params),
  );
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  const before = state.chatMessages;
  moveReader(241);
  const loading = pane.loadOlderMessages();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(6));
  moveReader(600);
  held.resolve({
    ...historyPage(Array.from({ length: 80 }, (_, index) => index + 81)),
    hasMore: true,
    olderCursor: "older-80",
    newerCursor: "newer-161",
    totalMessages: 640,
  });
  await expect(loading).resolves.toBe(false);
  expect(state.chatMessages).toBe(before);
  expect(state.chatHistoryPagination).toMatchObject({ olderCursor: "older-240" });
  expect(pane.history.olderError).toContain("loaded messages");
  moveReader(241);
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(request.mock.calls.filter(([, params]) => params.cursor === "older-160")).toHaveLength(2);
  expectNativeHistoryRange(state.chatMessages, 1, 400);
});

it("adopts later-packet user receipts while keeping a live publication made during the chain", async () => {
  const held = createDeferred<ChatHistoryResult>();
  const request = stagedPagesRequest({ 4: () => held.promise });
  const { pane, state } = createStagedPrefetchPane(request);
  const runId = "batch-input";
  const { persisted, pending } = pendingInput(state, runId, "Accepted input");
  const loading = pane.loadOlderMessages();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const live = nativeHistoryMessage(9);
  reduceChatSessionProjection(state, { type: "messagePersisted", message: live });
  const published = vi.spyOn(state, "chatMessages", "set");
  const durable = persisted(3);
  held.resolve({
    ...historyPage([3, 4], pagination(9, 6)),
    messages: [durable, nativeHistoryMessage(4)],
  });
  await expect(loading).resolves.toBe(true);
  expect(published).toHaveBeenCalledTimes(1);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(state.chatMessages.at(-1)).toBe(live);
  expect(pending()).toBe(false);
});

it("does not adopt an overflow packet's pending receipt before its actual admission", async () => {
  const { pane, state, request, moveReader } = packetHistoryPane();
  const runId = "overflow-input";
  const { persisted, pending } = pendingInput(state, runId, "Queued source");
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (method, params) => {
    const result = await base(method, params);
    if (params.cursor === "older-80") {
      result.messages![0] = persisted(1);
    }
    return result;
  });

  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(pending()).toBe(true);
  expect(pane.stagedHistory.page).not.toBeNull();
  moveReader(81);
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(pending()).toBe(false);
  expect(state.chatMessages.some((message) => nativeHistorySeq(message) === 1)).toBe(true);
  expect(request).toHaveBeenCalledTimes(5);
});

it.each(["around", "older", "newer"] as const)(
  "publishes receipt retirement once for %s admission",
  (direction) => {
    const { state } = createStagedPrefetchPane(vi.fn());
    const runId = "admitted-input";
    const { persisted, pending } = pendingInput(state, runId, "Admitted source");
    const durable = persisted(1);
    const published = vi.spyOn(state, "chatMessages", "set");
    admitChatHistoryPages(state, [{ messages: [durable] }], direction);
    expect(published).toHaveBeenCalledTimes(1);
    expect(state.chatMessages).toContain(durable);
    expect(pending()).toBe(false);
  },
);

it.each(
  ["cursor", "projection", "connection", "route", "hidden"].flatMap((change) =>
    ["resolved", "rejected"].map((outcome) => ({ change, outcome })),
  ),
)(
  "discards a collected packet prefix after $change supersession ($outcome)",
  async ({ change, outcome }) => {
    const second = createDeferred<ChatHistoryResult>();
    const request = stagedPagesRequest({ 4: () => second.promise });
    const { pane, state } = createStagedPrefetchPane(request);
    const runId = "superseded-input";
    const { persisted, pending } = pendingInput(state, runId, "Not yet admitted");
    const loading = pane.loadOlderMessages();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    if (change === "cursor") {
      state.chatHistoryPagination = pagination(8, 5);
    }
    if (change === "projection") {
      resetChatHistoryProjection(state);
    }
    if (change === "connection") {
      state.connectionEpoch++;
    }
    if (change === "route") {
      state.sessionKey = "agent:main:successor";
    }
    if (change === "hidden") {
      pane.presented = false;
    }
    const before = state.chatMessages;
    const published = vi.spyOn(state, "chatMessages", "set");
    const durable = persisted(3);
    if (outcome === "resolved") {
      second.resolve({
        ...historyPage([3, 4], pagination(8, 6)),
        messages: [durable, nativeHistoryMessage(4)],
      });
    } else {
      second.reject(new Error("obsolete private packet"));
    }
    await expect(loading).resolves.toBe(false);
    expect(state.chatMessages).toBe(before);
    expect(published).not.toHaveBeenCalled();
    expect(pane.stagedHistory.page).toBeNull();
    if (change === "cursor" || change === "projection") {
      expect(pane.history.olderError).toBe("History refreshed before this page loaded. Try again.");
      expect(pending()).toBe(change === "cursor");
    } else {
      expect(pane.history.olderError).toBeNull();
      expect(state.lastError).toBeNull();
    }
  },
);

it("keeps prefetch failures silent and retries reactively", async () => {
  const nextPage = vi
    .fn()
    .mockRejectedValueOnce(new Error("prefetch boom"))
    .mockReturnValue(historyPage([5, 6], pagination(20, 10)));
  const request = sparsePrefetchRequest({ 8: nextPage });
  const { pane, state } = createStagedPrefetchPane(request);

  await pane.loadOlderMessages();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
  await vi.waitFor(() => expect(pane.stagedHistory.load).toBeNull());

  expect(state.lastError).toBeNull();
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(nextPage).toHaveBeenCalledTimes(2);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

it("keeps bounded prefetch usable after its own same-session reload", async () => {
  const pages = sparsePrefetchRequest();
  let reset = false;
  const request = vi.fn(
    (method: string, params: { cursor?: string }, options?: { signal?: AbortSignal }) => {
      expect(options?.signal?.aborted).toBe(false);
      if (!params.cursor) {
        return Promise.resolve(historyPage([7, 8], { ...pagination(20, 2), sessionId: "current" }));
      }
      if (!reset) {
        reset = true;
        return Promise.resolve({ windowReset: true, sessionId: "current" });
      }
      return pages(method, params).then((result) => ({ ...result, sessionId: "current" }));
    },
  );
  const { pane, state } = createStagedPrefetchPane(request);
  state.currentSessionId = "current";
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(pane.stagedHistory.controller.signal.aborted).toBe(false);
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  await vi.waitFor(() => expect(pane.stagedHistory.page).not.toBeNull());
  expect(pages.mock.calls.map(([, params]) => params.cursor)).toEqual([
    "older-2",
    "older-4",
    "older-6",
    "older-8",
  ]);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([7, 8]);
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

it.each([
  { keyed: false, reader: false },
  { keyed: false, reader: true },
  { keyed: true, reader: false },
  { keyed: true, reader: true },
])(
  "navigates into and past an intrinsic source from a nonempty window (id=$keyed reader=$reader)",
  async ({ keyed, reader }) => {
    const row = (seq: number, text?: string) =>
      Object.assign(nativeHistoryMessage(seq, text), {
        __openclaw: { seq, ...(keyed ? { id: `source-${seq}` } : {}) },
      });
    const page = (start: number, end: number): ChatHistoryResult => ({
      messages: Array.from({ length: end - start + 1 }, (_, index) => row(start + index)),
      hasMore: start > 1,
      ...(start > 1 ? { olderCursor: `older-${start - 1}` } : {}),
      ...(end < 402 ? { newerCursor: `newer-${end + 1}` } : {}),
      totalMessages: 402,
    });
    const fragments = Array.from({ length: 401 }, (_, index) => row(2, `fragment-${index}`));
    const request = vi.fn(async (_method: string, params: { cursor: string }) => {
      const [direction, raw] = params.cursor.split("-");
      const edge = Number(raw);
      return edge === 2
        ? { ...page(2, 2), messages: fragments }
        : direction === "older"
          ? page(Math.max(1, edge - 79), edge)
          : page(edge, Math.min(402, edge + 79));
    });
    const { pane, state } = createStagedPrefetchPane(request);
    admitChatHistoryPages(state, [page(323, 402)], "around");
    admitChatHistoryPages(
      state,
      [page(243, 322), page(163, 242), page(83, 162), page(3, 82)],
      "older",
    );
    let anchor = reader ? `${keyed ? "id:source-" : "seq:"}42` : null;
    state.readTranscriptReaderSnapshot = () => ({
      anchor,
      visibleSources: anchor ? [anchor] : [],
    });
    await expect(pane.loadOlderMessages()).resolves.toBe(true);
    expect(state.chatMessages.filter((value) => nativeHistorySeq(value) === 2)).toEqual(fragments);
    expect(state.chatHistoryPagination.hasNewer).toBe(true);
    if (reader) {
      expect(state.chatMessages.some((value) => nativeHistorySeq(value) === 42)).toBe(true);
    }
    anchor = `${keyed ? "id:source-" : "seq:"}2`;
    if (state.chatHistoryPagination.hasMore) {
      await expect(pane.loadOlderMessages()).resolves.toBe(true);
    }
    expect(nativeHistorySeq(state.chatMessages[0])).toBe(1);
    expect(state.chatHistoryPagination.hasMore).toBe(false);
    expect(state.chatMessages.filter((value) => nativeHistorySeq(value) === 2)).toEqual(fragments);
    for (let step = 0; state.chatHistoryPagination.hasNewer && step < 6; step++) {
      const last = nativeHistorySeq(state.chatMessages.at(-1))!;
      anchor = `${keyed ? "id:source-" : "seq:"}${last}`;
      await expect(pane.loadNewerMessages()).resolves.toBe(true);
    }
    expect(nativeHistorySeq(state.chatMessages.at(-1))).toBe(402);
    expect(state.chatHistoryPagination.hasNewer).toBeUndefined();
    expect(request.mock.calls.some(([, params]) => params.cursor.startsWith("newer-"))).toBe(true);
    for (const [, params] of request.mock.calls) {
      expect(params).not.toHaveProperty("messageId");
    }
  },
);

it.each(["older", "newer"] as const)(
  "refines an unfit ordinary %s packet at its same cursor before admitting a bounded prefix",
  async (direction) => {
    const groups = Array.from({ length: 7 }, (_, index) =>
      Array.from(
        { length: index === (direction === "older" ? 6 : 0) ? 1 : 100 },
        (_unused, fragment) => nativeHistoryMessage(index + 1, `fragment-${fragment}`),
      ),
    );
    const initial = direction === "older" ? 7 : 1;
    const request = vi.fn(async (_method: string, params: { cursor: string; limit: number }) => {
      const [movement, raw] = params.cursor.split("-");
      const edge = Number(raw);
      const start = movement === "older" ? Math.max(1, edge - params.limit + 1) : edge;
      const end = movement === "older" ? edge : Math.min(7, edge + params.limit - 1);
      return {
        messages: groups.slice(start - 1, end).flat(),
        hasMore: start > 1,
        ...(start > 1 ? { olderCursor: `older-${start - 1}` } : {}),
        ...(end < 7 ? { newerCursor: `newer-${end + 1}` } : {}),
      };
    });
    const { pane, state } = createStagedPrefetchPane(request);
    readChatInputRunIds(state);
    admitChatHistoryPages(
      state,
      [
        {
          messages: groups[initial - 1],
          hasMore: initial > 1,
          ...(initial > 1 ? { olderCursor: `older-${initial - 1}` } : {}),
          ...(initial < 7 ? { newerCursor: `newer-${initial + 1}` } : {}),
        },
      ],
      "around",
    );
    state.readTranscriptReaderSnapshot = () => ({
      anchor: `seq:${initial}`,
      visibleSources: [`seq:${initial}`],
    });
    const published = vi.spyOn(state, "chatMessages", "set");
    await expect(
      direction === "older" ? pane.loadOlderMessages() : pane.loadNewerMessages(),
    ).resolves.toBe(true);
    expect(
      request.mock.calls.slice(0, 2).map(([, params]) => [params.cursor, params.limit]),
    ).toEqual([
      [`${direction}-${direction === "older" ? 6 : 2}`, 399],
      [`${direction}-${direction === "older" ? 6 : 2}`, 1],
    ]);
    expect(published).toHaveBeenCalledTimes(1);
    expect(state.chatMessages).toHaveLength(101);
    expect(state.chatMessages).toEqual(
      direction === "older" ? [...groups[5]!, ...groups[6]!] : [...groups[0]!, ...groups[1]!],
    );
    expect(pane.stagedHistory.page).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  },
);

it("refines multiple intrinsic sources without granting their whole packet an exception", async () => {
  const a = fragmentedSource(2);
  const b = fragmentedSource(1);
  const request = vi.fn(async (_method: string, params: { cursor: string; limit: number }) =>
    params.cursor === "older-2"
      ? {
          messages: params.limit === 1 ? a : [...b, ...a],
          hasMore: params.limit === 1,
          ...(params.limit === 1 ? { olderCursor: "older-1" } : {}),
          newerCursor: "newer-3",
        }
      : { messages: b, hasMore: false, newerCursor: "newer-2" },
  );
  const { pane, state } = createStagedPrefetchPane(request);
  readChatInputRunIds(state);
  admitChatHistoryPages(
    state,
    [{ messages: [nativeHistoryMessage(3)], hasMore: true, olderCursor: "older-2" }],
    "around",
  );
  let reader = "seq:3";
  state.readTranscriptReaderSnapshot = () => ({
    anchor: reader,
    visibleSources: reader ? [reader] : [],
  });
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(state.chatMessages).toEqual([...a, nativeHistoryMessage(3)]);
  expect(request.mock.calls.slice(0, 2).map(([, params]) => [params.cursor, params.limit])).toEqual(
    [
      ["older-2", 399],
      ["older-2", 1],
    ],
  );
  reader = "seq:2";
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(state.chatMessages.filter((message) => nativeHistorySeq(message) === 1)).toEqual(b);
});

it.each([
  { direction: "older", unrelated: false },
  { direction: "older", unrelated: true },
  { direction: "newer", unrelated: false },
  { direction: "newer", unrelated: true },
] as const)(
  "pauses a narrow $direction packet until its reader moves (unrelated=$unrelated)",
  async ({ direction, unrelated }) => {
    const a = fragmentedSource(direction === "older" ? 3 : 1);
    const b = fragmentedSource(2);
    const c = fragmentedSource(direction === "older" ? 1 : 3);
    const page = (messages: unknown[], seq: number): ChatHistoryResult => ({
      messages,
      hasMore: seq > 1,
      ...(seq > 1 ? { olderCursor: `older-${seq - 1}` } : {}),
      ...(seq < 3 ? { newerCursor: `newer-${seq + 1}` } : {}),
    });
    const request = vi.fn(async (_method: string, _params: { limit: number }) =>
      page(c, direction === "older" ? 1 : 3),
    );
    const { pane, state } = createStagedPrefetchPane(request);
    let reader = `seq:${direction === "older" ? 3 : 1}`;
    state.readTranscriptReaderSnapshot = () => ({
      anchor: reader,
      visibleSources: reader ? [reader] : [],
    });
    admitChatHistoryPages(state, [page(a, direction === "older" ? 3 : 1)], "around");
    admitChatHistoryPages(state, [page(b, 2)], direction);
    const before = state.chatMessages;
    const coverage = state.chatHistoryPagination;
    const published = vi.spyOn(state, "chatMessages", "set");
    const load = () =>
      direction === "older" ? pane.loadOlderMessages() : pane.loadNewerMessages();
    await expect(load()).resolves.toBe(false);
    expect(state.chatMessages).toBe(before);
    expect(state.chatHistoryPagination).toBe(coverage);
    expect(published).not.toHaveBeenCalled();
    expect(direction === "older" ? pane.history.olderError : state.lastError).toContain(
      "loaded messages",
    );
    expect(pane.stagedHistory.page?.result.messages).toEqual(c);
    expect(
      pane.stagedHistory.page?.result.messages?.every((message, index) => message === c[index]),
    ).toBe(true);
    expect(request.mock.calls.map(([, params]) => params.limit)).toEqual([80, 1]);
    await expect(load()).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    if (unrelated) {
      state.lastError = "Unrelated newer notice";
    }
    reader = "seq:2";
    await expect(load()).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(pane.stagedHistory.page).toBeNull();
    expect(published).toHaveBeenCalledTimes(1);
    expect(state.chatMessages).toEqual(direction === "older" ? [...c, ...b] : [...b, ...c]);
    expect(state.chatHistoryPagination.intrinsicSource).toBe(
      `seq:${direction === "older" ? 1 : 3}`,
    );
    expect(pane.history.olderError).toBeNull();
    expect(state.lastError).toBe(unrelated ? "Unrelated newer notice" : null);
  },
);

it.each(["fit", "raw"] as const)(
  "releases a rejected %s body before the narrower response settles",
  async (rejection) => {
    const narrow = createDeferred<ChatHistoryResult>();
    const requested = createDeferred();
    let rejected: WeakRef<object> | undefined;
    const request = vi.fn(async (_method: string, params: { limit: number }) => {
      if (params.limit === (rejection === "fit" ? 1 : 80)) {
        requested.resolve();
        return narrow.promise;
      }
      const messages = Array.from({ length: 6 }, (_, index) =>
        Array.from({ length: 100 }, (_unused, fragment) =>
          nativeHistoryMessage(
            index + 1,
            `fragment-${fragment}${rejection === "raw" ? "x".repeat(600) : ""}`,
          ),
        ),
      ).flat();
      rejected = new WeakRef(messages[0]!);
      return { messages, hasMore: false, newerCursor: "newer-7" };
    });
    const { pane, state } = createStagedPrefetchPane(request);
    readChatInputRunIds(state);
    admitChatHistoryPages(
      state,
      [{ messages: [nativeHistoryMessage(7)], hasMore: true, olderCursor: "older-6" }],
      "around",
    );
    state.readTranscriptReaderSnapshot = () => ({ anchor: "seq:7", visibleSources: ["seq:7"] });
    const loading = pane.loadOlderMessages();
    await requested.promise;
    try {
      expect(rejected).toBeDefined();
      // Mock result histories own resolved promises independently of the producer.
      request.mockClear();
      const control = await (async () => new WeakRef({ unowned: true }))();
      await collectGarbageForTest();
      expect(control.deref()).toBeUndefined();
      expect(rejected?.deref()).toBeUndefined();
      expect(state.chatMessages.map(nativeHistorySeq)).toEqual([7]);
    } finally {
      narrow.resolve({
        messages: [nativeHistoryMessage(6)],
        hasMore: false,
        newerCursor: "newer-7",
      });
      await loading;
    }
  },
);

it.each([true, false])(
  "preserves reverse navigation after moving inside one original packet (id=%s)",
  async (keyed) => {
    const a = fragmentedSource(1, keyed);
    const b = fragmentedSource(2, keyed);
    const c = nativeHistoryMessage(3);
    const request = vi.fn(
      async (_method: string, params: { messageId?: string; cursor?: string; limit?: number }) => {
        if (params.messageId === "source-2") {
          return {
            messages: b,
            sessionId: "current",
            hasMore: true,
            olderCursor: "older-1",
            newerCursor: "newer-3",
          };
        }
        if (params.cursor === "newer-3") {
          return { messages: [c], sessionId: "current", hasMore: true, olderCursor: "older-2" };
        }
        if (params.cursor === "older-2") {
          return {
            messages: params.limit === 1 ? b : [...a, ...b],
            sessionId: "current",
            hasMore: true,
            olderCursor: "older-1",
            newerCursor: "newer-3",
          };
        }
        if (params.cursor === "older-1") {
          return { messages: a, sessionId: "current", hasMore: false, newerCursor: "newer-2" };
        }
        throw new Error("Unexpected source boundary read");
      },
    );
    const { pane, state } = createStagedPrefetchPane(request);
    state.currentSessionId = "current";
    expect(getChatSessionProjection(state).scope.agentId).toBeUndefined();
    readChatInputRunIds(state);
    expect(getChatSessionProjection(state).scope.agentId).toBe("main");
    let reader = `${keyed ? "id:source-" : "seq:"}1`;
    state.readTranscriptReaderSnapshot = () => ({
      anchor: reader,
      visibleSources: reader ? [reader] : [],
    });
    admitChatHistoryPages(
      state,
      [
        {
          messages: [...a, ...b],
          sessionId: "current",
          newerCursor: "newer-3",
          packet: prepareChatHistoryPacket([...a, ...b], { hasMore: false }, "newer-3"),
        },
      ],
      "around",
    );
    reader = `${keyed ? "id:source-" : "seq:"}2`;
    publishChatSessionProjection(state, getChatSessionProjection(state));
    if (keyed) {
      expect(state.chatMessages).toEqual(b);
      expect(state.chatHistoryPagination).toMatchObject({ hasMore: true, needsBoundary: true });
      expect(state.chatHistoryPagination.segments?.[0]).not.toHaveProperty("boundedPacket", true);
    } else {
      expect(state.chatMessages).toEqual([...a, ...b]);
      expect(state.chatHistoryPagination).toMatchObject({ hasMore: false, newerCursor: "newer-3" });
      expect(state.chatHistoryPagination.segments?.[0]?.boundedPacket).toBe(true);
      // Leave the original packet, then retire it as one unit with its raw edge.
      await expect(pane.loadNewerMessages()).resolves.toBe(true);
      reader = "seq:3";
      publishChatSessionProjection(state, getChatSessionProjection(state));
      expect(state.chatMessages).toEqual([c]);
      expect(state.chatHistoryPagination).toMatchObject({ hasMore: true, olderCursor: "older-2" });
    }
    await expect(pane.loadOlderMessages()).resolves.toBe(true);
    if (!keyed) {
      expect(state.chatMessages).toEqual([...b, c]);
      expect(
        request.mock.calls
          .filter(([, params]) => params.cursor === "older-2")
          .map(([, params]) => params.limit),
      ).toEqual([399, 1]);
      reader = "seq:2";
      await expect(pane.loadOlderMessages()).resolves.toBe(true);
    }
    expect(new Set(state.chatMessages.map(nativeHistorySeq))).toEqual(
      new Set(keyed ? [1, 2] : [1, 2, 3]),
    );
    expect(pane.history.olderError).toBeNull();
  },
);

it.each(["older", "newer"] as const)(
  "reports boundary-only exhaustion as progress without a capacity warning (%s)",
  async (direction) => {
    const message = Object.assign(nativeHistoryMessage(2), {
      __openclaw: { id: "source-2", seq: 2 },
    });
    const request = vi.fn(async (_method: string, _params: unknown, _options?: unknown) => ({
      messages: [message],
      sessionId: "current",
      hasMore: false,
    }));
    const { pane, state } = createStagedPrefetchPane(request);
    state.currentSessionId = "current";
    admitChatHistoryPages(state, [{ messages: [message], sessionId: "current" }], "around");
    state.chatHistoryPagination =
      direction === "older"
        ? { hasMore: true, needsBoundary: true }
        : { hasMore: false, hasNewer: true, needsNewerBoundary: true };
    const published = vi.spyOn(state, "chatMessages", "set");
    await expect(
      direction === "older" ? pane.loadOlderMessages() : pane.loadNewerMessages(),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ messageId: "source-2", limit: 1 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(state.chatMessages).toEqual([message]);
    expect(published).not.toHaveBeenCalled();
    expect(state.chatHistoryPagination.hasMore).toBe(false);
    expect(state.chatHistoryPagination.hasNewer).toBeUndefined();
    expect(pane.history.olderError).toBeNull();
    expect(state.lastError).toBeNull();
  },
);
