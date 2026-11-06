/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { t } from "../../i18n/index.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import "./chat-pane.tsx";
import * as historyBudget from "./chat-history-request-budget.ts";
import { admitChatHistoryPages, type ChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  createStagedPrefetchPane,
  nativeHistoryMessage,
  nativeHistorySeq,
  expectNativeHistoryRange,
} from "./chat-pane-history.test-support.ts";
import { readChatInputRunIds } from "./chat-pending-inputs.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "./history-merge.ts";

type Request = { cursor: string; limit: number; maxBytes: number };
type Direction = "older" | "newer";

function source(seq: number, keyed = true) {
  return Object.assign(nativeHistoryMessage(seq, "x".repeat(4_000)), {
    __openclaw: { seq, ...(keyed ? { id: `source-${seq}` } : {}) },
  });
}

function page(first: number, last: number): ChatHistoryResult {
  return {
    messages: Array.from({ length: last - first + 1 }, (_, index) => source(first + index)),
    hasMore: first > 1,
    ...(first > 1 ? { olderCursor: `older-${first - 1}` } : {}),
    ...(last < 900 ? { newerCursor: `newer-${last + 1}` } : {}),
  };
}

function holdCapacityReply(direction: Direction, initialReader: number | null = null) {
  const broad = createDeferred<ChatHistoryResult>();
  const narrowed = createDeferred<ChatHistoryResult>();
  const wire = (params: Request): ChatHistoryResult => {
    const edge = Number(params.cursor.split("-")[1]);
    const older = params.cursor.startsWith("older-");
    let first = older ? Math.max(1, edge - params.limit + 1) : edge;
    let last = older ? edge : Math.min(900, edge + params.limit - 1);
    while (
      new TextEncoder().encode(JSON.stringify(page(first, last).messages)).length > params.maxBytes
    ) {
      if (older) {
        first++;
      } else {
        last--;
      }
    }
    return page(first, last);
  };
  let second: Request | undefined;
  const request = vi.fn(async (_method: string, params: Request) => {
    if (request.mock.calls.length === 1) {
      return broad.promise;
    }
    if (request.mock.calls.length === 2) {
      second = params;
      return narrowed.promise;
    }
    return wire(params);
  });
  const { pane, state } = createStagedPrefetchPane(request);
  readChatInputRunIds(state);
  const start = direction === "older" ? 518 : 1;
  for (let first = start; first < start + 383; first += 59) {
    const result = page(first, Math.min(start + 382, first + 58));
    expect(result.messages!.length).toBeLessThanOrEqual(80);
    expect(new TextEncoder().encode(JSON.stringify(result.messages)).length).toBeLessThanOrEqual(
      256 * 1024,
    );
    admitChatHistoryPages(state, [result], first === start ? "around" : "newer");
  }
  let reader = initialReader;
  state.readTranscriptReaderSnapshot = () =>
    reader === null
      ? null
      : {
          anchor: `id:source-${reader}`,
          visibleSources: [`id:source-${reader}`],
        };
  const loading = direction === "older" ? pane.loadOlderMessages() : pane.loadNewerMessages();
  return {
    pane,
    state,
    request,
    broad,
    wire,
    loading,
    mount: (seq: number) => {
      reader = seq;
    },
    finish: async () => {
      broad.resolve({ messages: [], hasMore: false });
      narrowed.resolve(second ? wire(second) : { messages: [], hasMore: false });
      return loading;
    },
  };
}

it.each(["older", "newer"] as const)(
  "reissues a strictly smaller adaptive budget when a reader mounts during a %s reply",
  async (direction) => {
    const broad = createDeferred<ChatHistoryResult>();
    const narrowed = createDeferred<ChatHistoryResult>();
    const wire = (params: Request): ChatHistoryResult => {
      const edge = Number(params.cursor.split("-")[1]);
      const older = params.cursor.startsWith("older-");
      let first = older ? Math.max(1, edge - params.limit + 1) : edge;
      let last = older ? edge : Math.min(900, edge + params.limit - 1);
      const result = () => ({
        ...page(first, last),
        ...(last < 900 ? { newerCursor: "newer-" + (last + 1) } : {}),
      });
      while (new TextEncoder().encode(JSON.stringify(result().messages)).length > params.maxBytes) {
        if (older) {
          first++;
        } else {
          last--;
        }
      }
      return result();
    };
    let second: Request | undefined;
    const request = vi.fn(async (_method: string, params: Request) => {
      if (request.mock.calls.length === 1) {
        return broad.promise;
      }
      if (request.mock.calls.length === 2) {
        second = params;
        return narrowed.promise;
      }
      return wire(params);
    });
    const { pane, state } = createStagedPrefetchPane(request);
    readChatInputRunIds(state);
    const start = direction === "older" ? 518 : 1;
    // Build the resident window from ordinary compliant packets, not an oversized startup reply.
    for (let first = start; first < start + 383; first += 59) {
      const last = Math.min(start + 382, first + 58);
      const result = {
        ...page(first, last),
        ...(last < 900 ? { newerCursor: "newer-" + (last + 1) } : {}),
      };
      expect(result.messages!.length).toBeLessThanOrEqual(80);
      expect(new TextEncoder().encode(JSON.stringify(result.messages)).length).toBeLessThanOrEqual(
        256 * 1024,
      );
      admitChatHistoryPages(state, [result], first === start ? "around" : "newer");
    }
    let reader: number | null = null;
    state.readTranscriptReaderSnapshot = () =>
      reader === null
        ? null
        : { anchor: "id:source-" + reader, visibleSources: ["id:source-" + reader] };
    const before = state.chatMessages;
    const coverage = state.chatHistoryPagination;
    const projection = getChatSessionProjection(state);
    const loading = direction === "older" ? pane.loadOlderMessages() : pane.loadNewerMessages();
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(request.mock.calls[0]![1]).toMatchObject({
        limit: 400,
        maxBytes: 3 * 1024 * 1024 - 1,
      });
      reader = direction === "older" ? 563 : 338;
      broad.resolve(wire(request.mock.calls[0]![1]));
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(state.chatMessages).toBe(before);
      expect(state.chatHistoryPagination).toBe(coverage);
      expect(getChatSessionProjection(state)).toBe(projection);
      expect(pane.stagedHistory.page).toBeNull();
      expect(request.mock.calls[1]![1]).toMatchObject({
        cursor: request.mock.calls[0]![1].cursor,
        limit: 354,
      });
      expect(request.mock.calls[1]![1].maxBytes).toBeLessThan(request.mock.calls[0]![1].maxBytes);
      expect(request.mock.calls[1]![1].maxBytes).toBeGreaterThan(256 * 1024);
    } finally {
      broad.resolve({ messages: [], hasMore: false });
      narrowed.resolve(second ? wire(second) : { messages: [], hasMore: false });
      await loading;
    }
    const retained = state.chatMessages.map(nativeHistorySeq);
    expect(retained).toEqual(
      Array.from({ length: 400 }, (_, index) => (direction === "older" ? 164 : 338) + index),
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(pane.stagedHistory.page).toBeNull();
    expect(pane.stagedHistory.load).toBeNull();
  },
);

it.each(["older", "newer"] as const)(
  "shrinks a %s retry when an already mounted reader moves during the reply",
  async (direction) => {
    const fixture = holdCapacityReply(direction, direction === "older" ? 541 : 360);
    const { request, broad, state, pane } = fixture;
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(request.mock.calls[0]![1].limit).toBe(376);
      fixture.mount(direction === "older" ? 563 : 338);
      const before = state.chatMessages;
      const coverage = state.chatHistoryPagination;
      broad.resolve(fixture.wire(request.mock.calls[0]![1]));
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(request.mock.calls[1]![1]).toMatchObject({
        cursor: request.mock.calls[0]![1].cursor,
        limit: 354,
      });
      expect(request.mock.calls[1]![1].maxBytes).toBeLessThan(request.mock.calls[0]![1].maxBytes);
      expect(state.chatMessages).toBe(before);
      expect(state.chatHistoryPagination).toBe(coverage);
      expect(pane.stagedHistory.page).toBeNull();
    } finally {
      await fixture.finish();
    }
    expectNativeHistoryRange(state.chatMessages, direction === "older" ? 164 : 338, 400);
  },
);

it("reserves a new canonical local reply before retrying the pending broad page", async () => {
  const fixture = holdCapacityReply("newer");
  const { state, request, broad, pane } = fixture;
  const local = { role: "system", content: "local reply".repeat(10_000) };
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    reduceChatSessionProjection(state, { type: "localOutput", message: local });
    const before = state.chatMessages;
    const coverage = state.chatHistoryPagination;
    broad.resolve(fixture.wire(request.mock.calls[0]![1]));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]![1]).toMatchObject({
      cursor: request.mock.calls[0]![1].cursor,
      limit: 399,
    });
    expect(request.mock.calls[1]![1].maxBytes).toBeLessThan(request.mock.calls[0]![1].maxBytes);
    expect(state.chatMessages).toBe(before);
    expect(state.chatHistoryPagination).toBe(coverage);
    expect(pane.stagedHistory.page).toBeNull();
  } finally {
    await fixture.finish();
  }
  expect(state.chatMessages.filter((message) => message === local)).toHaveLength(1);
  expect(state.chatMessages.filter((message) => message !== local).map(nativeHistorySeq)).toEqual(
    Array.from({ length: 399 }, (_, index) => 384 + index),
  );
  expect(state.chatMessages).toHaveLength(400);
});

it("retires a narrower adaptive reply without adopting its bodies or issuing another read", async () => {
  const fixture = holdCapacityReply("newer");
  const { state, request, broad, pane } = fixture;
  const before = state.chatMessages;
  const coverage = state.chatHistoryPagination;
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    fixture.mount(338);
    broad.resolve(fixture.wire(request.mock.calls[0]![1]));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]![1].limit).toBe(354);
    state.connectionEpoch++;
  } finally {
    await expect(fixture.finish()).resolves.toBe(false);
  }
  expect(request).toHaveBeenCalledTimes(2);
  expect(state.chatMessages).toBe(before);
  expect(state.chatHistoryPagination).toBe(coverage);
  expect(pane.stagedHistory.page).toBeNull();
});

it.each([
  { name: "unchanged", limit: 400, maxBytes: 3 * 1024 * 1024 - 1 },
  { name: "larger entry", limit: 401, maxBytes: 3 * 1024 * 1024 - 2 },
  { name: "larger byte", limit: 399, maxBytes: 3 * 1024 * 1024 },
  { name: "unavailable", limit: undefined, maxBytes: undefined },
])(
  "uses sticky small bounds instead of a $name replacement envelope",
  async ({ limit, maxBytes }) => {
    const readBudget = historyBudget.readChatHistoryRequestBudget;
    const budget = vi
      .spyOn(historyBudget, "readChatHistoryRequestBudget")
      .mockImplementationOnce(readBudget)
      .mockReturnValueOnce(limit === undefined ? undefined : { limit, maxBytes: maxBytes! });
    const fixture = holdCapacityReply("newer");
    const { request, broad } = fixture;
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      const reply = fixture.wire(request.mock.calls[0]![1]);
      // A wire source can project multiple distinct entries; 400 source IDs do
      // not certify that the 800 projected fragments fit the resident entry cap.
      reply.messages = Array.from({ length: request.mock.calls[0]![1].limit }, (_, index) => {
        const message = source(384 + index);
        return [
          { ...message, content: "first".repeat(200) },
          { ...message, content: "second".repeat(200) },
        ];
      }).flat();
      broad.resolve(reply);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(request.mock.calls[1]![1]).toMatchObject({
        cursor: request.mock.calls[0]![1].cursor,
        limit: 80,
        maxBytes: 256 * 1024,
      });
    } finally {
      await fixture.finish();
      budget.mockRestore();
    }
    expect(
      request.mock.calls
        .slice(1)
        .every(([, params]) => params.limit === 80 && params.maxBytes === 256 * 1024),
    ).toBe(true);
  },
);

it("reports capacity when eight strictly smaller adaptive replies still cannot coexist with the moving reader", async () => {
  const replies = Array.from({ length: 8 }, () => createDeferred<ChatHistoryResult>());
  const request = vi.fn(
    async (_method: string, _params: Request) => replies[request.mock.calls.length - 1]!.promise,
  );
  const { pane, state } = createStagedPrefetchPane(request);
  readChatInputRunIds(state);
  for (let first = 1; first <= 383; first += 59) {
    admitChatHistoryPages(
      state,
      [page(first, Math.min(383, first + 58))],
      first === 1 ? "around" : "newer",
    );
  }
  let reader = 383;
  state.readTranscriptReaderSnapshot = () => ({
    anchor: `id:source-${reader}`,
    visibleSources: [`id:source-${reader}`],
  });
  const before = state.chatMessages;
  const coverage = state.chatHistoryPagination;
  const loading = pane.loadNewerMessages();
  try {
    for (let index = 0; index < replies.length; index++) {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(index + 1));
      const issued = request.mock.calls[index]![1];
      expect(issued).toMatchObject({ cursor: "newer-384", limit: 399 - index });
      expect(issued.maxBytes).toBeGreaterThan(256 * 1024);
      const result = page(384, 383 + issued.limit);
      expect(new TextEncoder().encode(JSON.stringify(result.messages)).length).toBeLessThanOrEqual(
        issued.maxBytes,
      );
      reader = 382 - index;
      replies[index]!.resolve(result);
    }
    await expect(loading).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(8);
    expect(state.chatMessages).toBe(before);
    expect(state.chatHistoryPagination).toBe(coverage);
    expect(pane.stagedHistory.page).toBeNull();
    expect(state.lastError).toBe(t("chat.thread.historyCapacity"));
  } finally {
    for (const reply of replies) {
      reply.resolve({ messages: [], hasMore: false });
    }
    await loading;
  }
});

it("charges an uncovered streaming pin arriving during the broad reply without inventing page coverage", async () => {
  const fixture = holdCapacityReply("newer");
  const { state, request, broad } = fixture;
  const pinned = {
    ...source(901),
    role: "assistant",
    content: "pinned reply".repeat(10_000),
    __openclaw: { id: "source-901", seq: 901, runId: "pending" },
  };
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    reduceChatSessionProjection(state, { type: "runDelta", runId: "pending", message: pinned });
    reduceChatSessionProjection(state, {
      type: "messagePersisted",
      message: pinned,
      envelope: { runId: "pending" },
    });
    expect(
      getChatSessionProjection(state).entries.find((entry) => entry.message === pinned)?.live,
    ).toBe(true);
    expect(
      state.chatHistoryPagination.segments?.flatMap((segment) => segment.sources),
    ).not.toContain("id:source-901");
    const before = state.chatMessages;
    const coverage = state.chatHistoryPagination;
    broad.resolve(fixture.wire(request.mock.calls[0]![1]));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]![1]).toMatchObject({
      cursor: request.mock.calls[0]![1].cursor,
      limit: 399,
    });
    expect(request.mock.calls[1]![1].maxBytes).toBeLessThan(request.mock.calls[0]![1].maxBytes);
    expect(state.chatMessages).toBe(before);
    expect(state.chatHistoryPagination).toBe(coverage);
  } finally {
    await fixture.finish();
  }
  expect(state.chatMessages.filter((message) => message === pinned)).toHaveLength(1);
  expect(state.chatMessages.filter((message) => message !== pinned).map(nativeHistorySeq)).toEqual(
    Array.from({ length: 399 }, (_, index) => 384 + index),
  );
  expect(state.chatMessages).toHaveLength(400);
});

it("releases rejected broad bodies while the smaller adaptive reply is pending", async () => {
  const narrowed = createDeferred<ChatHistoryResult>();
  let rejected: WeakRef<object> | undefined;
  let reader: number | null = null;
  const request = vi.fn(async (_method: string, params: Request) => {
    if (params.limit === 354) {
      return narrowed.promise;
    }
    if (params.limit === 400) {
      const messages = Array.from({ length: 400 }, (_, index) => source(384 + index));
      rejected = new WeakRef(messages[0]!);
      reader = 338;
      return { ...page(384, 783), messages };
    }
    return page(738, 783);
  });
  const { pane, state } = createStagedPrefetchPane(request);
  readChatInputRunIds(state);
  for (let first = 1; first <= 383; first += 59) {
    admitChatHistoryPages(
      state,
      [page(first, Math.min(383, first + 58))],
      first === 1 ? "around" : "newer",
    );
  }
  state.readTranscriptReaderSnapshot = () =>
    reader === null
      ? null
      : {
          anchor: `id:source-${reader}`,
          visibleSources: [`id:source-${reader}`],
        };
  const loading = pane.loadNewerMessages();
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(rejected).toBeDefined();
    expect(request.mock.calls.map(([, params]) => params.limit)).toEqual([400, 354]);
    request.mockClear();
    const control = await (async () => new WeakRef({ unowned: true }))();
    await collectGarbageForTest();
    expect(control.deref()).toBeUndefined();
    expect(rejected?.deref()).toBeUndefined();
    expectNativeHistoryRange(state.chatMessages, 1, 383);
  } finally {
    narrowed.resolve(page(384, 737));
    await loading;
  }
});
