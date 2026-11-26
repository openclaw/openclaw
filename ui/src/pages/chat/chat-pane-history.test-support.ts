import { expect, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createInitializationContext } from "./chat-application-context.test-support.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import type { StagedOlderHistoryPage } from "./chat-history-request.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  createRenderTestChatPane,
  createTestChatPane as createBaseTestChatPane,
  nativeHistoryMessage,
  type TestChatPane as BaseTestChatPane,
} from "./chat-pane.test-support.ts";
import { buildMessageItems } from "./chat-thread-items.ts";
import { createTranscriptMessageElements } from "./components/chat-transcript-message-elements.ts";
import { resetChatScroll } from "./scroll.ts";

export { nativeHistoryMessage, transcriptScrollFact } from "./chat-pane.test-support.ts";

export function createRefreshChatPane(client?: GatewayBrowserClient) {
  const baseContext = createInitializationContext();
  if (client) {
    Object.assign(baseContext.gateway.snapshot, { client, phase: "connected" });
  }
  const sessions = createTestSessionCapability(baseContext.gateway);
  sessions.reconcile(undefined, undefined, { resultAgentId: "main" });
  vi.spyOn(sessions, "listBranches").mockResolvedValue([]);
  const context = { ...baseContext, sessions };
  const pane = createRenderTestChatPane();
  const state = pane.initialize(context);
  if (client) {
    Object.assign(state, { client, connected: true });
  }
  return { pane, state, context };
}

type TestChatPane = Omit<BaseTestChatPane, "loadOlderMessages"> & {
  loadOlderMessages: (readerIntent?: boolean) => Promise<boolean>;
  loadNewerMessages: () => Promise<boolean>;
  stagedHistory: {
    controller: AbortController;
    page: StagedOlderHistoryPage | null;
    load: Promise<void> | null;
  };
  replyMessageStatus: (messageId: string) => string | undefined;
  openReplyMessage: (messageId: string) => Promise<void>;
  currentReplyNavigationId: (sessionKey: string) => string | null;
  visuallyPresented: boolean;
};

export function createTestChatPane(
  params: NonNullable<Parameters<typeof createBaseTestChatPane>[0]> & {
    client: GatewayBrowserClient;
  },
) {
  const sessions =
    params.sessions ?? createTestSessionCapability(createGatewayHarness(params.client).gateway);
  if (!params.sessions) {
    vi.spyOn(sessions, "listBranches").mockResolvedValue([]);
  }
  const { pane: basePane, state } = createBaseTestChatPane({ client: params.client, sessions });
  // SAFETY: The runtime test host forwards the protected history surface declared above.
  const pane = basePane as TestChatPane;
  resetChatScroll(state);
  vi.spyOn(pane.transcript, "isPositionSettled", "get").mockReturnValue(true);
  return { pane, state };
}

export function expectNativeHistoryRange(
  messages: readonly unknown[],
  first: number,
  count: number,
) {
  expect(messages.map(nativeHistorySeq)).toEqual(
    Array.from({ length: count }, (_, index) => first + index),
  );
}

export function nativeHistorySeq(message: unknown): number | undefined {
  const metadata = (message as { __openclaw?: { seq?: unknown } })["__openclaw"];
  return typeof metadata?.seq === "number" ? metadata.seq : undefined;
}

export function appendChatThread(
  pane: Pick<BaseTestChatPane, "append" | "transcript">,
  options: { clientHeight?: number; scrollHeight?: number; scrollTop?: number } = {},
) {
  const thread = document.createElement("div");
  thread.className = "chat-thread";
  thread.scrollTop = options.scrollTop ?? 0;
  Object.defineProperty(thread, "clientHeight", { value: options.clientHeight ?? 500 });
  Object.defineProperty(thread, "scrollHeight", {
    configurable: true,
    value: options.scrollHeight ?? 2_000,
  });
  pane.append(thread);
  vi.spyOn(pane.transcript, "scrollElement", "get").mockReturnValue(thread);
  return thread;
}

function createPaginatedChatPane(request: ReturnType<typeof vi.fn>, firstSeq: number) {
  const result = createTestChatPane({ client: { request } as unknown as GatewayBrowserClient });
  result.state.chatMessages = [firstSeq, firstSeq + 1].map((seq) => nativeHistoryMessage(seq));
  result.state.chatHistoryPagination = {
    hasMore: true,
    nextOffset: 2,
    olderCursor: "older-2",
    totalMessages: firstSeq + 1,
  };
  return result;
}

export function createNativeShowEarlierPane(request: ReturnType<typeof vi.fn>, firstSeq = 3) {
  const result = createPaginatedChatPane(request, firstSeq);
  const thread = appendChatThread(result.pane);
  vi.spyOn(result.pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
  const scrollToOffset = vi.spyOn(result.pane.transcript, "scrollToOffset");
  return { ...result, scrollToOffset, thread };
}

type HistoryPageFactory = () => ChatHistoryResult | Promise<ChatHistoryResult>;

export function stagedPagesRequest(overrides: Record<number, HistoryPageFactory> = {}) {
  const pages: Record<number, HistoryPageFactory> = { ...overrides };
  for (const offset of [2, 4, 6]) {
    pages[offset] ??= () => ({
      messages: [7 - offset, 8 - offset].map((seq) => nativeHistoryMessage(seq)),
      hasMore: offset < 6,
      ...(offset < 6 ? { olderCursor: `older-${offset + 2}` } : {}),
      totalMessages: 8,
    });
  }
  return vi.fn(async (_method: string, params: { cursor?: string }) => {
    const page = pages[Number(params.cursor?.replace("older-", ""))];
    if (!page) {
      throw new Error(`no scripted page for cursor ${String(params.cursor)}`);
    }
    return page();
  });
}

export const createStagedPrefetchPane = (request: ReturnType<typeof vi.fn>) =>
  createPaginatedChatPane(request, 7);

type HistoryPageOverrides = Partial<Omit<ChatHistoryResult, "messages">>;

export function historyPage(seqs = [1, 2], extra: HistoryPageOverrides = {}) {
  return {
    messages: seqs.map((seq) => nativeHistoryMessage(seq)),
    ...pagination(),
    ...extra,
  };
}

export function sparsePrefetchRequest(overrides: Record<number, HistoryPageFactory> = {}) {
  return stagedPagesRequest({
    2: () => historyPage([], pagination(20, 4)),
    4: () => historyPage([], pagination(20, 6)),
    6: () => historyPage([], pagination(20, 8)),
    8: () => historyPage([5, 6], pagination(20, 10)),
    10: () => historyPage([3, 4], pagination(20, 12)),
    12: () => historyPage([1, 2], pagination(20)),
    ...overrides,
  });
}

export function pagination(totalMessages = 4, nextOffset?: number): ChatHistoryPagination {
  return nextOffset === undefined
    ? { hasMore: false, totalMessages }
    : { hasMore: true, nextOffset, olderCursor: `older-${nextOffset}`, totalMessages };
}

export type CapacityHistoryRequest = { cursor: string; limit: number; maxBytes: number };

export function createRelocatedHistorySource(tier: "disk" | "memory") {
  const text = tier === "memory" ? "x".repeat(160 * 1024) : "message";
  return Array.from({ length: 82 }, (_, index) => {
    const seq = index + 1;
    return {
      ...nativeHistoryMessage(seq, text),
      __openclaw: {
        id: `source-${seq}`,
        seq,
        transcriptPosition: {
          source: "history",
          rawSeq: seq,
          ...(seq === 8 ? { activity: { afterRawSeq: 1, scopeId: "tool", startOrder: 0 } } : {}),
        },
      },
    };
  });
}

export function createCapacityHistoryPages(lastSource: number) {
  const source = (seq: number, keyed = true) =>
    Object.assign(nativeHistoryMessage(seq, "x".repeat(4_000)), {
      __openclaw: { seq, ...(keyed ? { id: `source-${seq}` } : {}) },
    });
  const page = (first: number, last: number, keyed = true): ChatHistoryResult => ({
    messages: Array.from({ length: last - first + 1 }, (_, index) => source(first + index, keyed)),
    hasMore: first > 1,
    ...(first > 1 ? { olderCursor: `older-${first - 1}` } : {}),
    ...(last < lastSource ? { newerCursor: `newer-${last + 1}` } : {}),
  });
  const wire = (params: CapacityHistoryRequest, buildPage = page): ChatHistoryResult => {
    const edge = Number(params.cursor.split("-")[1]);
    const older = params.cursor.startsWith("older-");
    let first = older ? Math.max(1, edge - params.limit + 1) : edge;
    let last = older ? edge : Math.min(lastSource, edge + params.limit - 1);
    while (
      new TextEncoder().encode(JSON.stringify(buildPage(first, last).messages)).length >
      params.maxBytes
    ) {
      if (older) {
        first++;
      } else {
        last--;
      }
    }
    return buildPage(first, last);
  };
  return { source, page, wire };
}

export function mountHistoryReader(
  pane: Pick<BaseTestChatPane, "append" | "transcript">,
  {
    thread = appendChatThread(pane),
    detached = false,
    bottom = 80,
    bottomStep = 100,
    markId = false,
  } = {},
) {
  vi.spyOn(thread, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 500 } as DOMRect);
  const refs = createTranscriptMessageElements(() => undefined);
  vi.spyOn(pane.transcript, "messageElements", "get").mockReturnValue(refs);
  return (messages: unknown[]) => {
    thread.replaceChildren();
    return buildMessageItems(messages).map((item, index) => {
      const bubble = document.createElement("div");
      if (markId) {
        bubble.dataset.messageId = item.key;
      }
      if (!detached) {
        thread.append(bubble);
      }
      vi.spyOn(bubble, "getBoundingClientRect").mockReturnValue({
        top: 20 + index * 100,
        bottom: bottom + index * bottomStep,
      } as DOMRect);
      refs.forKey(item.key)(bubble);
      return bubble;
    });
  };
}
