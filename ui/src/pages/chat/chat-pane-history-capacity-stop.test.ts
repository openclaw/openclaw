/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import "./chat-pane.tsx";
import { admitChatHistoryPages } from "./chat-pane-history-packets.runtime.ts";
import {
  createStagedPrefetchPane,
  createCapacityHistoryPages,
  type CapacityHistoryRequest as Request,
  expectNativeHistoryRange,
} from "./chat-pane-history.test-support.ts";
import { readChatInputRunIds } from "./chat-pending-inputs.ts";

const { page, wire } = createCapacityHistoryPages(900);

it.each(["older", "newer"] as const)(
  "settles a full adaptive %s admission without a small probe and resumes at its exact edge",
  async (direction) => {
    const request = vi.fn(async (_method: string, params: Request) => {
      const result = wire(params);
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
