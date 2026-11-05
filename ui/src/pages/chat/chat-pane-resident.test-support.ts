import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { CHAT_HISTORY_REQUEST_LIMIT } from "./chat-history-request-params.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  appendChatThread,
  createTestChatPane,
  nativeHistoryMessage,
} from "./chat-pane-history.test-support.ts";

export function residentPane(
  decorate?: (messages: Record<string, unknown>[]) => void,
  initialTotal = 640,
) {
  let total = initialTotal;
  let tailOverride: ChatHistoryResult | undefined;
  let cursorGate: Promise<void> | undefined;
  let tailGate: Promise<void> | undefined;
  const requests: Array<{ cursor?: string; messageId?: string; offset?: number; limit?: number }> =
    [];
  const rows = (start: number, end: number) => {
    const messages = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => {
      const seq = start + index;
      const message = nativeHistoryMessage(seq, `body-${seq}`);
      return { ...message, __openclaw: { ...message["__openclaw"], id: `source-${seq}` } };
    });
    decorate?.(messages);
    return messages;
  };
  const page = (start: number, end: number) => ({
    messages: rows(start, end),
    sessionId: "resident-session",
    ...(start > 1 ? { olderCursor: `before-${start}` } : {}),
    ...(end < total ? { newerCursor: `after-${end}` } : {}),
  });
  // Primitive request facts only: the harness must not retain response bodies.
  const request = async (
    _method: string,
    selector: { cursor?: string; messageId?: string; offset?: number; limit?: number },
  ) => {
    requests.push({
      cursor: selector.cursor,
      messageId: selector.messageId,
      offset: selector.offset,
      limit: selector.limit,
    });
    if (selector.offset !== undefined) {
      throw new Error("Unexpected offset continuation");
    }
    if (selector.cursor && cursorGate) {
      const gate = cursorGate;
      cursorGate = undefined;
      await gate;
    }
    if (selector.messageId) {
      const seq = Number(selector.messageId.replace("source-", ""));
      const limit = selector.limit ?? 1;
      const older = limit - Math.floor(limit / 2) - 1;
      const start = Math.min(Math.max(1, seq - older), Math.max(1, total - limit + 1));
      return page(start, Math.min(total, start + limit - 1));
    }
    const limit = selector.limit ?? CHAT_HISTORY_REQUEST_LIMIT;
    if (selector.cursor?.startsWith("before-")) {
      const end = Number(selector.cursor.slice(7)) - 1;
      return page(Math.max(1, end - limit + 1), end);
    }
    if (selector.cursor?.startsWith("after-")) {
      const start = Number(selector.cursor.slice(6)) + 1;
      return page(start, Math.min(total, start + limit - 1));
    }
    if (selector.cursor) {
      throw new Error("Unexpected cursor");
    }
    if (tailGate) {
      const gate = tailGate;
      tailGate = undefined;
      await gate;
    }
    return (
      tailOverride ?? {
        ...page(total - 79, total),
        hasMore: true,
        totalMessages: total,
        nextOffset: 80,
      }
    );
  };
  const { pane, state } = createTestChatPane({
    client: { request } as unknown as GatewayBrowserClient,
  });
  appendChatThread(pane);
  vi.spyOn(pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
  return {
    pane,
    state,
    requests,
    holdNextCursor: () => {
      let release!: () => void;
      cursorGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    holdNextTail: (error?: Error) => {
      let release!: () => void;
      tailGate = new Promise<void>((resolve, reject) => {
        release = () => (error ? reject(error) : resolve());
      });
      return release;
    },
    append: (count: number) => {
      total += count;
      tailOverride = undefined;
    },
    replaceTail: (start: number, end: number, complete: boolean) => {
      total = end;
      tailOverride = {
        ...page(start, end),
        hasMore: !complete,
        totalMessages: total,
        ...(complete ? { completeSnapshot: true } : { nextOffset: end - start + 1 }),
      };
    },
  };
}
