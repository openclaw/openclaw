/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import * as historyIdentity from "../../lib/chat/history-message-identity.ts";
import { chatOutboxDeliveryKey } from "../../lib/chat/outbox-store.ts";
import "./chat-pane.tsx";
import { prepareChatHistoryPages, type ChatHistoryResult } from "./chat-history-snapshot.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  admitChatHistoryPagePrefix,
  admitChatHistoryPages,
} from "./chat-pane-history-packets.runtime.ts";
import {
  createStagedPrefetchPane,
  nativeHistoryMessage,
  nativeHistorySeq,
} from "./chat-pane-history.test-support.ts";
import { readChatInputRunIds } from "./chat-pending-inputs.ts";
import {
  getChatSessionProjection,
  readChatSessionProjection,
  reduceChatSessionProjection,
} from "./history-merge.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

it.each(["older", "newer"] as const)(
  "prepares a terminal %s prefix once for final admission",
  async (direction) => {
    const row = (seq: number, text?: string) => ({
      ...nativeHistoryMessage(seq, text),
      __openclaw: { id: `source-${seq}`, seq },
    });
    const page = (messages: ReturnType<typeof row>[]): ChatHistoryResult => {
      const first = messages[0]!["__openclaw"].seq;
      const last = messages.at(-1)!["__openclaw"].seq;
      return {
        messages,
        hasMore: first > 1,
        ...(first > 1 ? { olderCursor: `older-${first - 1}` } : {}),
        ...(last < 4 ? { newerCursor: `newer-${last + 1}` } : {}),
        totalMessages: 4,
      };
    };
    const held = (direction === "older" ? [3, 4] : [1, 2]).map((seq) => row(seq));
    const incoming = (direction === "older" ? [1, 2] : [3, 4]).map((seq) => row(seq));
    const runId = `terminal-${direction}`;
    Object.assign(incoming[0]!["__openclaw"], { idempotencyKey: `${runId}:user` });
    incoming[0]!.content = [{ type: "text", text: "Accepted terminal input" }];
    const request = vi.fn(
      async (_method: string, params: { cursor: string; limit: number; maxBytes: number }) => {
        expect(params.cursor).toBe(direction === "older" ? "older-2" : "newer-3");
        expect(incoming.length).toBeLessThanOrEqual(params.limit);
        expect(new TextEncoder().encode(JSON.stringify(incoming)).byteLength).toBeLessThanOrEqual(
          params.maxBytes,
        );
        return page(incoming);
      },
    );
    const { pane, state } = createStagedPrefetchPane(request);
    readChatInputRunIds(state);
    admitChatHistoryPages(state, [page(held)], "around");
    const reader = direction === "older" ? "id:source-3" : "id:source-2";
    state.readTranscriptReaderSnapshot = () => ({ anchor: reader, visibleSources: [reader] });
    reduceChatSessionProjection(state, {
      type: "sendPending",
      runId,
      message: {
        role: "user",
        content: "Accepted terminal input",
        __openclaw: { idempotencyKey: `${runId}:user` },
      },
    });
    expect(
      getChatSessionProjection(state).entries.some((entry) => entry.pendingRunId === runId),
    ).toBe(true);
    const previous = state.chatMessages;
    const published = vi.spyOn(state, "chatMessages", "set");
    const merged = vi.spyOn(historyIdentity, "prependUniqueNativeMessages");
    onTestFinished(() => merged.mockRestore());

    await expect(
      direction === "older" ? pane.loadOlderMessages() : pane.loadNewerMessages(),
    ).resolves.toBe(true);

    const expected = direction === "older" ? [...incoming, ...held] : [...held, ...incoming];
    expect(state.chatMessages).toEqual(expected);
    expect(state.chatMessages.every((message, index) => message === expected[index])).toBe(true);
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]);
    expect(state.chatHistoryPagination).toMatchObject({ hasMore: false });
    expect(state.chatHistoryPagination.hasNewer).toBeUndefined();
    expect(state.chatHistoryPagination.segments?.map((segment) => segment.sources)).toEqual([
      ["id:source-1", "id:source-2"],
      ["id:source-3", "id:source-4"],
    ]);
    expect(
      getChatSessionProjection(state).entries.some((entry) => entry.pendingRunId === runId),
    ).toBe(false);
    expect(published).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(pane.stagedHistory.page).toBeNull();
    expect(pane.stagedHistory.load).toBeNull();
    expect(pane.history.olderError).toBeNull();
    expect(state.lastError).toBeNull();

    // The response needs a fit after its await; final fit and commit share one
    // synchronous preparation instead of merging this identical prefix twice.
    const isIncoming = (messages: readonly unknown[]) =>
      messages.length === incoming.length &&
      messages.every((message, index) => message === incoming[index]);
    expect(
      merged.mock.calls.filter(([messages, current]) =>
        direction === "older"
          ? isIncoming(messages) && current === previous
          : messages === previous && isIncoming(current),
      ),
    ).toHaveLength(2);
  },
);

const admissionRow = (seq: number, text?: string) => ({
  ...nativeHistoryMessage(seq, text),
  __openclaw: { id: `source-${seq}`, seq },
});

it("refits cold admission after initialization acquires retained steering custody", () => {
  const runId = "retained-steer";
  const steering = buildLocalUserMessage({
    text: "s".repeat(3 * 1024 * 1024 - 64 * 1024),
    createdAt: 1,
    runId,
    steerTargetRunId: "active-run",
  });
  if (!steering) {
    throw new Error("Expected retained steering input");
  }
  const held = admissionRow(3);
  const host = makeChatHost({
    chatMessages: [held, steering],
    chatHistoryPagination: { hasMore: true, olderCursor: "older-2" },
  });
  host.readTranscriptReaderSnapshot = () => ({
    anchor: "id:source-3",
    visibleSources: ["id:source-3"],
  });
  const delivered = host.chatSubmissions!.retain({
    kind: "delivered",
    owner: host,
    sessionKey: host.sessionKey,
    deliveryKey: chatOutboxDeliveryKey(
      host,
      { sessionKey: host.sessionKey, agentId: "main" },
      runId,
    ),
    pendingRunId: runId,
    message: steering,
  });
  const incoming = {
    ...admissionRow(2, "n".repeat(80 * 1024)),
    role: "user",
    __openclaw: { id: "source-2", seq: 2, idempotencyKey: `${runId}:user` },
  };
  const result = {
    messages: [incoming],
    hasMore: true,
    olderCursor: "older-1",
    newerCursor: "newer-3",
  };
  expect(readChatSessionProjection(host)).toBeUndefined();
  expect(prepareChatHistoryPages(host, [result], "older").fits).toBe(true);
  expect(readChatSessionProjection(host)).toBeUndefined();

  expect(admitChatHistoryPagePrefix(host, [result], "older")).toEqual({
    acceptedCount: 0,
    change: false,
  });

  expect(
    readChatSessionProjection(host)?.entries.some((entry) => entry.pendingRunId === runId),
  ).toBe(true);
  expect(prepareChatHistoryPages(host, [result], "older").fits).toBe(false);
  expect(host.chatMessages).toEqual([held, steering]);
  expect(host.chatHistoryPagination.hasMore && host.chatHistoryPagination.olderCursor).toBe(
    "older-2",
  );
  expect(delivered?.pending).toBe(true);
});

it("refits learned scope while preserving typed local output custody", () => {
  const host = makeChatHost();
  const held = admissionRow(2);
  admitChatHistoryPages(
    host,
    [{ messages: [held], hasMore: true, olderCursor: "older-1" }],
    "around",
  );
  const local = { role: "system", content: "local result" };
  reduceChatSessionProjection(host, { type: "localOutput", message: local });
  const previousProjection = readChatSessionProjection(host);
  host.currentSessionId = "learned-session";
  const incoming = admissionRow(1);
  const merged = vi.spyOn(historyIdentity, "prependUniqueNativeMessages");
  onTestFinished(() => merged.mockRestore());

  expect(
    admitChatHistoryPagePrefix(
      host,
      [{ messages: [incoming], hasMore: false, newerCursor: "newer-2" }],
      "older",
    ),
  ).toEqual({ acceptedCount: 1, change: "messages" });

  const projection = readChatSessionProjection(host);
  expect(projection).not.toBe(previousProjection);
  expect(projection?.scope.sessionId).toBe("learned-session");
  expect(projection?.entries.find((entry) => entry.message === local)?.localOutput).toBe(true);
  expect(host.chatMessages).toEqual([incoming, held, local]);
  expect(host.chatMessages.filter((message) => message === local)).toHaveLength(1);
  expect(host.chatHistoryPagination).toMatchObject({ hasMore: false });
  expect(merged.mock.calls.filter(([messages]) => messages[0] === incoming)).toHaveLength(2);
});

it.each([false, true])(
  "does not initialize a cold rejected or empty prefix (empty=%s)",
  (empty) => {
    const held = admissionRow(3);
    const host = makeChatHost({
      chatMessages: [held],
      chatHistoryPagination: { hasMore: true, olderCursor: "older-2" },
    });
    host.readTranscriptReaderSnapshot = () => ({
      anchor: "id:source-3",
      visibleSources: ["id:source-3"],
    });
    const messages = Array.from({ length: 402 }, (_, index) =>
      admissionRow(index < 201 ? 1 : 2, `fragment-${index}`),
    );
    expect(new TextEncoder().encode(JSON.stringify(messages)).byteLength).toBeLessThan(256 * 1024);
    const previous = host.chatMessages;
    const coverage = host.chatHistoryPagination;
    expect(readChatSessionProjection(host)).toBeUndefined();

    expect(
      admitChatHistoryPagePrefix(host, empty ? [] : [{ messages, hasMore: false }], "older"),
    ).toEqual({
      acceptedCount: 0,
      change: false,
    });

    expect(readChatSessionProjection(host)).toBeUndefined();
    expect(host.chatMessages).toBe(previous);
    expect(host.chatHistoryPagination).toBe(coverage);
  },
);

it("distinguishes an accepted no-change prefix from capacity rejection", () => {
  const host = makeChatHost();
  const held = admissionRow(1);
  const result = { messages: [held], hasMore: false };
  admitChatHistoryPages(host, [result], "around");
  const previous = host.chatMessages;

  expect(admitChatHistoryPagePrefix(host, [result], "older")).toEqual({
    acceptedCount: 1,
    change: false,
  });

  expect(host.chatMessages).toBe(previous);
  expect(host.chatHistoryPagination.hasMore).toBe(false);
  expect(host.lastError).toBeNull();
});

it("accepts receipts only from the final kept prefix", () => {
  const host = makeChatHost();
  const held = Array.from({ length: 400 }, (_, index) => admissionRow(index + 401));
  admitChatHistoryPages(
    host,
    [{ messages: held, hasMore: true, olderCursor: "older-400" }],
    "around",
  );
  host.readTranscriptReaderSnapshot = () => ({
    anchor: "id:source-401",
    visibleSources: ["id:source-401"],
  });
  const runId = "rejected-receipt";
  reduceChatSessionProjection(host, {
    type: "sendPending",
    runId,
    message: {
      role: "user",
      content: "rejected input",
      __openclaw: { idempotencyKey: `${runId}:user` },
    },
  });
  const kept = Array.from({ length: 200 }, (_, index) => admissionRow(index + 201));
  const rejected = Array.from({ length: 200 }, (_, index) => admissionRow(index + 1));
  Object.assign(rejected[0]!["__openclaw"], { idempotencyKey: `${runId}:user` });
  const result = admitChatHistoryPagePrefix(
    host,
    [
      { messages: kept, hasMore: true, olderCursor: "older-200", newerCursor: "newer-401" },
      { messages: rejected, hasMore: false, newerCursor: "newer-201" },
    ],
    "older",
  );

  expect(result).toEqual({ acceptedCount: 1, change: "messages" });
  expect(
    host.chatMessages
      .filter((message) => nativeHistorySeq(message) !== undefined)
      .map(nativeHistorySeq),
  ).toEqual(Array.from({ length: 399 }, (_, index) => index + 201));
  expect(host.chatMessages).toHaveLength(400);
  expect(
    readChatSessionProjection(host)?.entries.some((entry) => entry.pendingRunId === runId),
  ).toBe(true);
  expect(host.chatHistoryPagination.hasMore && host.chatHistoryPagination.olderCursor).toBe(
    "older-200",
  );
  expect(
    host.chatMessages.some((message) => rejected.some((candidate) => candidate === message)),
  ).toBe(false);
});
