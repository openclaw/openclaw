// Shared mocks, fixtures, and coordinator helpers for dispatch-acp-delivery.test.ts.
//
// The vi.hoisted mock objects live here and are consumed by the vi.mock factories in the
// test file. The vi.mock calls themselves must stay in the test file: Vitest hoists a test
// file's vi.mock above all of its imports, so the mocks register before dispatch-acp-delivery.js
// (whose reply-threading dependency binds getChannelPlugin at module-eval time) is loaded.
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
}));

const deliveryMocks = vi.hoisted(() => ({
  routeReply: vi.fn(
    async (
      _params: unknown,
    ): Promise<{
      ok: boolean;
      messageId?: string;
      suppressed?: boolean;
      reason?: string;
    }> => ({ ok: true, messageId: "mock-message" }),
  ),
  runMessageAction: vi.fn(async (_params: unknown) => ({ ok: true as const })),
}));

const channelPluginMocks = vi.hoisted(() => ({
  accountIds: ["default"] as string[],
  defaultAccountId: undefined as string | undefined,
  replyToModeForAccount: undefined as
    | ((accountId: string | null | undefined) => "all" | "off")
    | undefined,
  shouldTreatDeliveredTextAsVisible: (({
    kind,
    text,
  }: {
    kind: "tool" | "block" | "final";
    text?: string;
  }) => kind === "block" && typeof text === "string" && text.trim().length > 0) as
    | ((params: { kind: "tool" | "block" | "final"; text?: string }) => boolean)
    | undefined,
  shouldTreatRoutedTextAsVisible: undefined as
    | ((params: { kind: "tool" | "block" | "final"; text?: string }) => boolean)
    | undefined,
  getChannelPlugin: vi.fn((channelId: string) => {
    if (channelId !== "visiblechat") {
      return undefined;
    }
    return {
      config: {
        listAccountIds: () => channelPluginMocks.accountIds,
        resolveAccount: () => ({}),
        ...(channelPluginMocks.defaultAccountId
          ? { defaultAccountId: () => channelPluginMocks.defaultAccountId ?? "default" }
          : {}),
      },
      ...(channelPluginMocks.replyToModeForAccount
        ? {
            threading: {
              resolveReplyToMode: ({ accountId }: { accountId?: string | null }) =>
                channelPluginMocks.replyToModeForAccount?.(accountId) ?? "all",
            },
          }
        : {}),
      outbound: {
        shouldTreatDeliveredTextAsVisible: channelPluginMocks.shouldTreatDeliveredTextAsVisible,
        shouldTreatRoutedTextAsVisible: channelPluginMocks.shouldTreatRoutedTextAsVisible,
      },
    };
  }),
}));

export { channelPluginMocks, deliveryMocks, ttsMocks };

/** Resets delivery/channel mocks to their default per-test behavior. */
export function resetAcpDeliveryMocks(): void {
  deliveryMocks.routeReply.mockClear();
  deliveryMocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock-message" });
  deliveryMocks.runMessageAction.mockClear();
  deliveryMocks.runMessageAction.mockResolvedValue({ ok: true as const });
  channelPluginMocks.getChannelPlugin.mockClear();
  channelPluginMocks.accountIds = ["default"];
  channelPluginMocks.defaultAccountId = undefined;
  channelPluginMocks.replyToModeForAccount = undefined;
  channelPluginMocks.shouldTreatDeliveredTextAsVisible = ({
    kind,
    text,
  }: {
    kind: "tool" | "block" | "final";
    text?: string;
  }) => kind === "block" && typeof text === "string" && text.trim().length > 0;
  channelPluginMocks.shouldTreatRoutedTextAsVisible = undefined;
}

export function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

/** Standard visiblechat delivery coordinator for a caller-provided dispatcher. */
export function createDefaultCoordinator(dispatcher: ReplyDispatcher) {
  return createAcpDispatchDeliveryCoordinator({
    cfg: createAcpTestConfig(),
    ctx: visibleChatCtx(),
    dispatcher,
    inboundAudio: false,
    shouldRouteToOriginating: false,
  });
}

export function createCoordinator(onReplyStart?: (...args: unknown[]) => Promise<void>) {
  return createAcpDispatchDeliveryCoordinator({
    cfg: createAcpTestConfig(),
    ctx: visibleChatCtx(),
    dispatcher: createDispatcher(),
    inboundAudio: false,
    shouldRouteToOriginating: false,
    ...(onReplyStart ? { onReplyStart } : {}),
  });
}

export async function raceWithTimeoutResult<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutResult: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timeoutResult), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Canonical visiblechat message context shared by most coordinator fixtures. */
export function visibleChatCtx() {
  return buildTestCtx({
    Provider: "visiblechat",
    Surface: "visiblechat",
    SessionKey: "agent:codex-acp:session-1",
  });
}

export function createVisibleChatAcpCoordinator(cfg: OpenClawConfig) {
  return createAcpDispatchDeliveryCoordinator({
    cfg,
    ctx: visibleChatCtx(),
    dispatcher: createDispatcher(),
    inboundAudio: false,
    shouldRouteToOriginating: true,
    originatingChannel: "visiblechat",
    originatingTo: "channel:thread-1",
  });
}
