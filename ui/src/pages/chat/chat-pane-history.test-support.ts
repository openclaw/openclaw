import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  createInitializationContext,
  createRenderTestChatPane,
  createTestChatPane as createBaseTestChatPane,
  nativeHistoryMessage,
  type TestChatPane as BaseTestChatPane,
} from "./chat-pane.test-support.ts";
import { resetChatScroll } from "./scroll.ts";

export { nativeHistoryMessage } from "./chat-pane.test-support.ts";

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
    state.client = client;
    state.connected = true;
  }
  return { pane, state, context };
}

export type TestChatPane = Omit<BaseTestChatPane, "loadOlderMessages"> & {
  loadOlderMessages: () => Promise<boolean>;
  stagedOlder: { page: unknown; load: Promise<void> | null };
  replyMessageStatus: (messageId: string) => string | undefined;
  openReplyMessage: (messageId: string) => void;
  currentReplyNavigationId: (sessionKey: string) => string | null;
  visuallyPresented: boolean;
};

export function createTestChatPane(params: {
  client: GatewayBrowserClient;
  sessions?: SessionCapability;
}) {
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

export function nativeHistorySeq(message: unknown): number | undefined {
  const metadata = (message as Record<string, unknown>)["__openclaw"] as
    | Record<string, unknown>
    | undefined;
  return typeof metadata?.seq === "number" ? metadata.seq : undefined;
}

export function appendChatThread(
  pane: TestChatPane,
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
  const client = { request } as unknown as GatewayBrowserClient;
  const result = createTestChatPane({ client });
  result.state.chatMessages = [firstSeq, firstSeq + 1].map((seq) => nativeHistoryMessage(seq));
  result.state.chatHistoryPagination = {
    hasMore: true,
    nextOffset: 2,
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

export function stagedPagesRequest(overrides: Record<number, () => unknown> = {}) {
  const pages: Record<number, () => unknown> = { ...overrides };
  for (const offset of [2, 4, 6]) {
    pages[offset] ??= () => ({
      messages: [7 - offset, 8 - offset].map((seq) => nativeHistoryMessage(seq)),
      hasMore: offset < 6,
      ...(offset < 6 ? { nextOffset: offset + 2 } : {}),
      totalMessages: 8,
    });
  }
  return vi.fn(async (_method: string, params: { offset?: number }) => {
    const page = pages[params.offset ?? -1];
    if (!page) {
      throw new Error(`no scripted page for offset ${String(params.offset)}`);
    }
    return page();
  });
}

export function createStagedPrefetchPane(request: ReturnType<typeof vi.fn>) {
  return createPaginatedChatPane(request, 7);
}
