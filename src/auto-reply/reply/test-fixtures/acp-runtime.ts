import { vi } from "vitest";
// Test fixtures for ACP runtime sessions, bindings, and reply delivery.
import type { SessionAcpMeta } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ReplyDispatcher } from "../reply-dispatcher.types.js";

const settledCounts = (delivered: number) => ({
  delivered,
  deliveredNotVisible: 0,
  cancelled: 0,
  failedBeforeSend: 0,
  failedAfterSend: 0,
});

export function createAcpTestReplyDispatcher(): ReplyDispatcher {
  const sendToolResult = vi.fn(() => true);
  const sendBlockReply = vi.fn(() => true);
  const sendFinalReply = vi.fn(() => true);
  return {
    sendToolResult,
    sendBlockReply,
    sendFinalReply,
    supportsSettledReceipt: true,
    waitForIdle: vi.fn(async () => ({
      counts: {
        tool: settledCounts(sendToolResult.mock.calls.length),
        block: settledCounts(sendBlockReply.mock.calls.length),
        final: settledCounts(sendFinalReply.mock.calls.length),
      },
      anyVisibleDelivered:
        sendToolResult.mock.calls.length +
          sendBlockReply.mock.calls.length +
          sendFinalReply.mock.calls.length >
        0,
    })),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

export function createAcpTestReplyDispatcherFixture(): {
  dispatcher: ReplyDispatcher;
  counts: Record<"tool" | "block" | "final", number>;
} {
  return {
    dispatcher: createAcpTestReplyDispatcher(),
    counts: { tool: 0, block: 0, final: 0 },
  };
}

export function createAcpTestConfig(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      stream: {
        coalesceIdleMs: 0,
        maxChunkChars: 64,
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

export function createAcpSessionMeta(overrides?: Partial<SessionAcpMeta>): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime:1",
    mode: "persistent",
    state: "idle",
    lastActivityAt: Date.now(),
    identity: {
      state: "resolved",
      acpxSessionId: "acpx-session-1",
      source: "status",
      lastUpdatedAt: Date.now(),
    },
    ...overrides,
  };
}

export type AcpTestSessionBinding = {
  bindingId: string;
  targetSessionKey: string;
  targetKind: "subagent" | "session";
  conversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  status: "active";
  boundAt: number;
  metadata?: {
    agentId?: string;
    label?: string;
    boundBy?: string;
    webhookId?: string;
  };
};

export function createAcpTestSessionBinding(
  overrides?: Partial<AcpTestSessionBinding>,
): AcpTestSessionBinding {
  return {
    bindingId: "default:thread-created",
    targetSessionKey: "agent:codex:acp:s1",
    targetKind: "session",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-created",
      parentConversationId: "parent-1",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      agentId: "codex",
      boundBy: "user-1",
    },
    ...overrides,
  };
}
