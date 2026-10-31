/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import "./chat-pane.tsx";
import {
  admitChatHistoryPages,
  resolveChatHistoryPagination,
  type ChatHistoryResult,
} from "./chat-history-snapshot.ts";
import { prepareChatHistoryPacket } from "./chat-history-window.ts";
import {
  createStagedPrefetchPane,
  nativeHistoryMessage,
  nativeHistorySeq,
} from "./chat-pane-history.test-support.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "./history-merge.ts";

function source(seq: number, keyed = true) {
  return Object.assign(nativeHistoryMessage(seq, "x".repeat(4_000)), {
    __openclaw: { seq, ...(keyed ? { id: `source-${seq}` } : {}) },
  });
}

type Request = { cursor: string; limit: number; maxBytes: number };

function page(start: number, end: number, keyed = true): ChatHistoryResult {
  return {
    messages: Array.from({ length: end - start + 1 }, (_, index) => source(start + index, keyed)),
    hasMore: start > 1,
    ...(start > 1 ? { olderCursor: `older-${start - 1}` } : {}),
    ...(end < 400 ? { newerCursor: `newer-${end + 1}` } : {}),
  };
}

it.each([true, false])(
  "amortizes keyed foreground reads against the complete reader bridge (keyed bridge=%s)",
  async (keyedBridge) => {
    const request = vi.fn(async (_method: string, params: Request) => {
      const end = Number(params.cursor.split("-")[1]);
      return page(Math.max(1, end - params.limit + 1), end);
    });
    const { pane, state } = createStagedPrefetchPane(request);
    const initial = page(400, 400, keyedBridge);
    initial.packet = prepareChatHistoryPacket(
      initial.messages!,
      resolveChatHistoryPagination(initial),
    );
    admitChatHistoryPages(state, [initial], "around");
    state.readTranscriptAnchorSource = () => `${keyedBridge ? "id:source-" : "seq:"}400`;

    await expect(pane.loadOlderMessages()).resolves.toBe(true);

    expect(request.mock.calls[0]![1].limit).toBe(399);
    expect(request.mock.calls[0]![1].maxBytes).toBeGreaterThan(256 * 1024);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual(
      Array.from({ length: 400 }, (_, index) => index + 1),
    );
    expect(state.chatHistoryPagination.segments?.at(-1)?.boundedPacket).toBe(true);
    expect(state.chatHistoryPagination.segments?.[0]?.boundedPacket).not.toBe(true);
    expect(pane.stagedHistory.page).toBeNull();
  },
);

it.each(["unkeyed", "mixed", "hidden-unkeyed"] as const)(
  "retries an actual %s larger response at the same cursor and keeps that claim small-only",
  async (kind) => {
    const request = vi.fn(async (_method: string, params: Request) => {
      const end = Number(params.cursor.split("-")[1]);
      const result = page(Math.max(1, end - params.limit + 1), end, kind !== "unkeyed");
      if (kind !== "unkeyed") {
        result.messages![0] = {
          role: "user",
          content: kind === "hidden-unkeyed" ? "" : "unkeyed",
          __openclaw: { seq: nativeHistorySeq(result.messages![0]) },
        };
      }
      // The raw source still has its sequence when the server omits its reopenable ID.
      while (
        new TextEncoder().encode(JSON.stringify(result.messages)).byteLength > params.maxBytes
      ) {
        result.messages!.shift();
      }
      const first = nativeHistorySeq(result.messages![0])!;
      return {
        ...result,
        hasMore: first > 1,
        ...(first > 1 ? { olderCursor: `older-${first - 1}` } : {}),
      };
    });
    const { pane, state } = createStagedPrefetchPane(request);
    admitChatHistoryPages(state, [page(400, 400)], "around");
    state.readTranscriptAnchorSource = () => "id:source-400";

    await expect(pane.loadOlderMessages()).resolves.toBe(true);

    expect(
      request.mock.calls.slice(0, 2).map(([, params]) => [params.cursor, params.limit]),
    ).toEqual([
      ["older-399", 399],
      ["older-399", 80],
    ]);
    expect(request.mock.calls.slice(1).every(([, params]) => params.maxBytes === 256 * 1024)).toBe(
      true,
    );
    expect(state.chatMessages).toHaveLength(kind === "hidden-unkeyed" ? 399 : 400);
    expect(state.chatHistoryPagination.hasMore).toBe(false);
  },
);

it("does not certify a large raw packet after hidden rows reduce its visible body", async () => {
  const hidden = Array.from({ length: 100 }, (_, index) => ({
    role: "user",
    content: "",
    __openclaw: { id: `hidden-${index}`, seq: index + 1 },
  }));
  const request = vi.fn(async (_method: string, _params: Request) => ({
    messages: [...hidden, source(399)],
    hasMore: false,
  }));
  const { pane, state } = createStagedPrefetchPane(request);
  admitChatHistoryPages(state, [page(400, 400)], "around");
  state.readTranscriptAnchorSource = () => "id:source-400";
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([399, 400]);
  expect(state.chatHistoryPagination.segments?.[0]?.boundedPacket).not.toBe(true);
});

it("discards rejected raw receipts and edges before the same-cursor small reply settles", async () => {
  const small = createDeferred<ChatHistoryResult>();
  const request = vi.fn(async (_method: string, params: Request) =>
    params.limit > 80
      ? {
          messages: [
            {
              role: "user",
              content: "pending",
              __openclaw: { id: "receipt", seq: 1, idempotencyKey: "pending:user" },
            },
            ...page(2, 100, false).messages!,
          ],
          hasMore: true,
          olderCursor: "rejected-edge",
          inputReceipts: [
            { runId: "pending", state: "consumed" as const, consumedByEventId: "receipt" },
          ],
        }
      : small.promise,
  );
  const { pane, state } = createStagedPrefetchPane(request);
  admitChatHistoryPages(state, [page(400, 400)], "around");
  state.readTranscriptAnchorSource = () => "id:source-400";
  reduceChatSessionProjection(state, {
    type: "sendPending",
    runId: "pending",
    message: { role: "user", content: "pending", __openclaw: { idempotencyKey: "pending:user" } },
  });
  const before = state.chatMessages;
  const coverage = state.chatHistoryPagination;
  const loading = pane.loadOlderMessages();
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(([, params]) => params.cursor)).toEqual([
      "older-399",
      "older-399",
    ]);
    expect(state.chatMessages).toBe(before);
    expect(state.chatHistoryPagination).toBe(coverage);
    expect(getChatSessionProjection(state).entries.some((entry) => entry.pending)).toBe(true);
    expect(pane.stagedHistory.page).toBeNull();
  } finally {
    small.resolve({ messages: [source(399)], hasMore: false });
    await loading;
  }
});

it("uses the same capacity owner for foreground newer reads", async () => {
  const request = vi.fn(async (_method: string, params: Request) => {
    const start = Number(params.cursor.split("-")[1]);
    return page(start, Math.min(400, start + params.limit - 1));
  });
  const { pane, state } = createStagedPrefetchPane(request);
  const initial = page(1, 1);
  initial.packet = prepareChatHistoryPacket(
    initial.messages!,
    resolveChatHistoryPagination(initial),
    initial.newerCursor,
  );
  admitChatHistoryPages(state, [initial], "around");
  state.readTranscriptAnchorSource = () => "id:source-1";
  await expect(pane.loadNewerMessages()).resolves.toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![1]).toMatchObject({ cursor: "newer-2", limit: 399 });
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual(
    Array.from({ length: 400 }, (_, index) => index + 1),
  );
});

it("reports discarded large-prefix capacity after a local reply arrives during the next read", async () => {
  const next = createDeferred<ChatHistoryResult>();
  const request = vi.fn(async (_method: string, params: Request) =>
    params.cursor === "older-399" ? page(300, 399) : next.promise,
  );
  const { pane, state } = createStagedPrefetchPane(request);
  admitChatHistoryPages(state, [page(400, 400)], "around");
  state.readTranscriptAnchorSource = () => "id:source-400";
  const loading = pane.loadOlderMessages();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  reduceChatSessionProjection(state, {
    type: "localOutput",
    message: { role: "system", content: "x".repeat(3 * 1024 * 1024 - 100_000) },
  });
  const before = state.chatMessages;
  const coverage = state.chatHistoryPagination;
  next.resolve({ messages: [source(299)], hasMore: false });
  await expect(loading).resolves.toBe(false);
  expect(state.chatMessages).toBe(before);
  expect(state.chatHistoryPagination).toBe(coverage);
  expect(pane.stagedHistory.page).toBeNull();
  expect(pane.history.olderError).toContain("loaded messages");
});

it("keeps a fitting small prefix and prefetches from its edge after discarding later broad overflow", async () => {
  const next = createDeferred<ChatHistoryResult>();
  const request = vi.fn(async (_method: string, params: Request) => {
    if (params.cursor === "older-399") {
      return page(390, 399);
    }
    if (params.cursor === "older-389") {
      return params.maxBytes > 256 * 1024 ? page(300, 389) : page(389, 389);
    }
    return next.promise;
  });
  const { pane, state } = createStagedPrefetchPane(request);
  admitChatHistoryPages(state, [page(400, 400)], "around");
  state.readTranscriptAnchorSource = () => "id:source-400";
  const loading = pane.loadOlderMessages();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  const local = { role: "system", content: "x".repeat(3 * 1024 * 1024 - 100_000) };
  reduceChatSessionProjection(state, { type: "localOutput", message: local });
  next.resolve({ messages: [source(299)], hasMore: false });
  await expect(loading).resolves.toBe(true);
  await vi.waitFor(() => expect(pane.stagedHistory.load).toBeNull());
  expect(state.chatMessages.filter((value) => value !== local).map(nativeHistorySeq)).toEqual(
    Array.from({ length: 11 }, (_, index) => index + 390),
  );
  expect(state.chatMessages.filter((value) => value === local)).toHaveLength(1);
  expect(state.chatHistoryPagination).toMatchObject({ hasMore: true, olderCursor: "older-389" });
  expect(request.mock.calls.at(-1)![1]).toMatchObject({
    cursor: "older-389",
    limit: 80,
    maxBytes: 256 * 1024,
  });
  expect(pane.stagedHistory.page?.requestedCursor).toBe("older-389");
  expect(pane.stagedHistory.page?.result.packet?.boundedPacket).toBe(true);
  expect(pane.history.olderError).toBeNull();
});

it.each([true, false])(
  "retires a pending capacity-sized reply when its connection claim changes (keyed=%s)",
  async (keyed) => {
    const held = createDeferred<ChatHistoryResult>();
    const request = vi.fn(async (_method: string, _params: Request) => held.promise);
    const { pane, state } = createStagedPrefetchPane(request);
    admitChatHistoryPages(state, [page(400, 400)], "around");
    state.readTranscriptAnchorSource = () => "id:source-400";
    const before = state.chatMessages;
    const coverage = state.chatHistoryPagination;
    const loading = pane.loadOlderMessages();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    state.connectionEpoch++;
    held.resolve(page(1, 399, keyed));
    await expect(loading).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatMessages).toBe(before);
    expect(state.chatHistoryPagination).toBe(coverage);
    expect(pane.stagedHistory.page).toBeNull();
  },
);
