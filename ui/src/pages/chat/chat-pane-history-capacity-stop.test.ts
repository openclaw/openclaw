/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import "./chat-pane.tsx";
import { admitChatHistoryPages, type ChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  createStagedPrefetchPane,
  nativeHistoryMessage,
  expectNativeHistoryRange,
} from "./chat-pane-history.test-support.ts";
import { readChatInputRunIds } from "./chat-pending-inputs.ts";

type Request = { cursor: string; limit: number; maxBytes: number };

function page(first: number, last: number): ChatHistoryResult {
  return {
    messages: Array.from({ length: last - first + 1 }, (_, index) => {
      const seq = first + index;
      return Object.assign(nativeHistoryMessage(seq, "x".repeat(4_000)), {
        __openclaw: { id: `source-${seq}`, seq },
      });
    }),
    hasMore: first > 1,
    ...(first > 1 ? { olderCursor: `older-${first - 1}` } : {}),
    ...(last < 900 ? { newerCursor: `newer-${last + 1}` } : {}),
  };
}

it.each(["older", "newer"] as const)(
  "settles a full adaptive %s admission without a small probe and resumes at its exact edge",
  async (direction) => {
    const request = vi.fn(async (_method: string, params: Request) => {
      const edge = Number(params.cursor.split("-")[1]);
      let first = direction === "older" ? Math.max(1, edge - params.limit + 1) : edge;
      let last = direction === "older" ? edge : Math.min(900, edge + params.limit - 1);
      while (
        new TextEncoder().encode(JSON.stringify(page(first, last).messages)).length >
        params.maxBytes
      ) {
        if (direction === "older") {
          first++;
        } else {
          last--;
        }
      }
      const result = page(first, last);
      expect(result.messages!.length).toBeLessThanOrEqual(params.limit);
      expect(new TextEncoder().encode(JSON.stringify(result.messages)).length).toBeLessThanOrEqual(
        params.maxBytes,
      );
      return result;
    });
    const { pane, state } = createStagedPrefetchPane(request);
    readChatInputRunIds(state);
    let reader = direction === "older" ? 900 : 1;
    admitChatHistoryPages(state, [page(reader, reader)], "around");
    state.readTranscriptReaderSnapshot = () => ({
      anchor: `id:source-${reader}`,
      visibleSources: [`id:source-${reader}`],
    });
    const load = () =>
      direction === "older" ? pane.loadOlderMessages() : pane.loadNewerMessages();

    await expect(load()).resolves.toBe(true);
    expectNativeHistoryRange(state.chatMessages, direction === "older" ? 501 : 1, 400);
    const firstCalls = request.mock.calls.length;
    const stagedAfterFirst = pane.stagedHistory.page;
    const pendingAfterFirst = pane.stagedHistory.load;
    reader = direction === "older" ? 501 : 400;
    await expect(load()).resolves.toBe(true);
    expectNativeHistoryRange(state.chatMessages, direction === "older" ? 102 : 400, 400);
    expect(state.chatHistoryPagination).toMatchObject(
      direction === "older"
        ? { hasMore: true, olderCursor: "older-101" }
        : { hasNewer: true, newerCursor: "newer-800" },
    );

    expect(firstCalls).toBe(1);
    expect(stagedAfterFirst).toBeNull();
    expect(pendingAfterFirst).toBeNull();
    expect(request.mock.calls.map(([, params]) => [params.cursor, params.limit])).toEqual(
      direction === "older"
        ? [
            ["older-899", 399],
            ["older-500", 399],
          ]
        : [
            ["newer-2", 399],
            ["newer-401", 399],
          ],
    );
    expect(pane.stagedHistory.page).toBeNull();
    expect(pane.stagedHistory.load).toBeNull();
    expect(pane.history.olderError).toBeNull();
    expect(state.lastError).toBeNull();
  },
);
