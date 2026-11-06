import { expect, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createInitializationContext } from "./chat-application-context.test-support.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import type { StagedOlderHistoryPage } from "./chat-history-request.ts";
import { admitChatHistoryPages, type ChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  createRenderTestChatPane,
  createTestChatPane as createBaseTestChatPane,
  nativeHistoryMessage,
  type TestChatPane as BaseTestChatPane,
} from "./chat-pane.test-support.ts";
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

export function createNativeShowEarlierPane(request: ReturnType<typeof vi.fn>) {
  const result = createPaginatedChatPane(request, 3);
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

export function packetHistoryPane(total = 480) {
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

export function installHistoryObserver(intersect = true) {
  const observe = vi.fn();
  const disconnect = vi.fn();
  const construct =
    vi.fn<(callback: IntersectionObserverCallback, observer: IntersectionObserver) => void>();
  let rootMargin: string | undefined;
  class FakeIntersectionObserver {
    readonly root: IntersectionObserver["root"] | undefined;
    constructor(
      private readonly callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      rootMargin = options?.rootMargin;
      this.root = intersect ? undefined : (options?.root ?? null);
      construct(callback, this as unknown as IntersectionObserver);
    }
    disconnect() {
      disconnect();
    }
    observe(target: Element) {
      observe(target);
      if (intersect) {
        this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return { observe, disconnect, construct, rootMargin: () => rootMargin };
}

export function appendSentinel(thread: HTMLElement, pane: { historySentinel: HTMLElement | null }) {
  const sentinel = document.createElement("div");
  sentinel.className = "chat-history-sentinel";
  thread.append(sentinel);
  pane.historySentinel = sentinel;
  return sentinel;
}
