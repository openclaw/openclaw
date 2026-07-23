import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import type { ChatFollowUpMode } from "../../app/settings.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import type { ChatSideResultPending } from "../../lib/chat/side-result.ts";
import type { SessionCapability, SessionRefreshTarget } from "../../lib/sessions/index.ts";
import type { ChatCommandHost } from "./chat-commands.ts";
import type { ChatRunStartupState } from "./chat-run-startup.ts";
import type { ChatInputHistoryState } from "./input-history.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";

type ChatAgentsListSnapshot = Partial<Omit<AgentsListResult, "agents">> & {
  agents?: AgentsListResult["agents"];
};

export type ChatHost = ChatInputHistoryState &
  ChatCommandHost & {
    sessions: SessionCapability;
    client: GatewayBrowserClient | null;
    chatStream: string | null;
    connected: boolean;
    connectionEpoch?: number;
    chatAttachments: ChatAttachment[];
    chatQueue: ChatQueueItem[];
    chatQueueByScope?: Record<string, ChatQueueItem[]>;
    chatRunId: string | null;
    chatRunStartup?: ChatRunStartupState | null;
    chatRunUsageById?: Map<string, number>;
    chatSending: boolean;
    chatSendingScopeKey?: string | null;
    chatRunError?: { summary: string } | null;
    lastError?: string | null;
    chatError?: string | null;
    hello: GatewayHelloOk | null;
    renderLifecycle?: RenderLifecycle;
    requestUpdate?: () => void;
    refreshSessionsAfterChat: Map<string, SessionRefreshTarget>;
    chatSubmitGuards?: Map<string, Promise<void>>;
    chatSendTimingsByRun?: Map<string, ChatSendTimingEntry>;
    eventLogBuffer?: unknown[];
    assistantAgentId?: string | null;
    agentsList?: ChatAgentsListSnapshot | null;
    settings?: { chatFollowUpMode?: ChatFollowUpMode };
    /** Prepared from the browser override and current Gateway effective queue mode. */
    chatFollowUpMode?: ControlUiFollowUpMode;
    /** Selected message to reply to (right-click / keyboard shortcut). */
    chatReplyTarget?: {
      messageId: string;
      text: string;
      senderLabel?: string | null;
      sourceMessageId?: string | null;
    } | null;
    /** Placeholder for an in-flight /btw side question awaiting chat.side_result. */
    chatSideResultPending?: ChatSideResultPending | null;
    /** Retired/handled BTW run ids whose late events must not reach the transcript. */
    chatSideResultTerminalRuns?: Set<string>;
    /** Side-chat panel closed via X/Escape; a new question reopens it. */
    chatSideChatHidden?: boolean;
  };

type ChatSendAckStatus = "started" | "in_flight" | "ok" | "timeout" | "error";

type ChatSendAckServerTiming = {
  receivedToAckMs?: number;
  loadSessionMs?: number;
  prepareAttachmentsMs?: number;
};

export type ChatSendAck = {
  runId: string;
  status: ChatSendAckStatus;
  serverTiming?: ChatSendAckServerTiming;
};

function normalizeAckTimingValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeChatSendAckServerTiming(value: unknown): ChatSendAckServerTiming | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const receivedToAckMs = normalizeAckTimingValue(record.receivedToAckMs);
  const loadSessionMs = normalizeAckTimingValue(record.loadSessionMs);
  const prepareAttachmentsMs = normalizeAckTimingValue(record.prepareAttachmentsMs);
  const timing: ChatSendAckServerTiming = {
    ...(receivedToAckMs !== undefined ? { receivedToAckMs } : {}),
    ...(loadSessionMs !== undefined ? { loadSessionMs } : {}),
    ...(prepareAttachmentsMs !== undefined ? { prepareAttachmentsMs } : {}),
  };
  return Object.keys(timing).length > 0 ? timing : undefined;
}

export function normalizeChatSendAck(payload: unknown, fallbackRunId: string): ChatSendAck {
  if (!payload || typeof payload !== "object") {
    return { runId: fallbackRunId, status: "started" };
  }
  const record = payload as Record<string, unknown>;
  const runId =
    typeof record.runId === "string" && record.runId.trim() ? record.runId.trim() : fallbackRunId;
  const status = record.status;
  const serverTiming = normalizeChatSendAckServerTiming(record.serverTiming);
  return {
    runId,
    status:
      status === "in_flight" || status === "ok" || status === "timeout" || status === "error"
        ? status
        : "started",
    ...(serverTiming ? { serverTiming } : {}),
  };
}

export type TerminalFailureChatSendAck = ChatSendAck & { status: "timeout" | "error" };

// ChatSendAck's status is a union field, not a discriminant across object
// types; callers need this predicate to narrow the whole ack object.
export function isTerminalFailureChatSendAck(
  ack: ChatSendAck | null,
): ack is TerminalFailureChatSendAck {
  return ack?.status === "timeout" || ack?.status === "error";
}

export type ChatSendTimingEntry = {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  sendAttempts: number;
  sendState?: ChatQueueItem["sendState"];
  submittedAtMs: number;
  requestStartedAtMs?: number;
  ackAtMs?: number;
  ackStatus?: ChatSendAckStatus;
  firstAssistantVisibleRecorded?: boolean;
};
