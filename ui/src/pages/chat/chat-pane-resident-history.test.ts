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

type Selector = { cursor?: string; offset?: number };

it.each([
  { budget: "rows", pageSize: 80, textLength: 32, traversals: 6, total: 640 },
  { budget: "serialized weight", pageSize: 12, textLength: 16 * 1024, traversals: 17, total: 240 },
])("bounds resident $budget while navigating older source pages", async (scenario) => {
  const { pageSize, textLength, traversals, total } = scenario;
  function page(end: number) {
    const start = Math.max(1, end - pageSize + 1);
    const messages = Array.from({ length: end - start + 1 }, (_, index) => {
      const seq = start + index;
      const message = nativeHistoryMessage(seq, `${seq}: ${"x".repeat(textLength)}`);
      return { ...message, __openclaw: { ...message["__openclaw"], id: `source-${seq}` } };
    });
    // Each source response fits the existing 256 KiB directional request budget.
    expect(JSON.stringify(messages).length).toBeLessThan(256 * 1024);
    return {
      messages,
      sessionId: "resident-physical-session",
      ...(start > 1 ? { olderCursor: `before-${start}` } : {}),
      ...(end < total ? { newerCursor: `after-${end}` } : {}),
    };
  }
  const request = vi.fn(async (_method: string, selector: Selector) => {
    if (selector.cursor?.startsWith("before-")) {
      return page(Number(selector.cursor.slice("before-".length)) - 1);
    }
    if (selector.cursor !== undefined || selector.offset !== undefined) {
      throw new Error("Unexpected resident-history selector");
    }
    return {
      ...page(total),
      hasMore: true,
      totalMessages: total,
      nextOffset: pageSize,
    };
  });
  const { pane, state } = createTestChatPane({
    client: { request } as unknown as GatewayBrowserClient,
  });
  appendChatThread(pane);
  vi.spyOn(pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
  await loadChatHistory(state, { deferBranches: true });

  for (let index = 1; index <= traversals; index++) {
    expect(await pane.loadOlderMessages(false)).toBe(true);
    expect(nativeHistorySeq(state.chatMessages[0])).toBe(total - pageSize * (index + 1) + 1);
  }

  expect(request.mock.calls.slice(1).every(([, selector]) => selector.offset === undefined)).toBe(
    true,
  );
  expect(state.chatMessages.length).toBeLessThanOrEqual(400);
  expect(JSON.stringify(state.chatMessages).length).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(state.currentSessionId).toBe("resident-physical-session");
});
