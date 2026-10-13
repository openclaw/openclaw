import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString as toText,
} from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import { isMeaningfulMediaFact, readPersistedMediaFacts } from "../media/media-facts.js";

/**
 * Shared channel MCP contracts and normalization helpers.
 *
 * These shapes are intentionally smaller than raw Gateway payloads so MCP tools
 * can return stable structured content without exposing every session detail.
 */
export type ClaudeChannelMode = "off" | "on" | "auto";

/** Conversation route information required to read and reply through a channel session. */
export type ConversationDescriptor = {
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
};

type SessionRow = {
  key: string;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
};

export type SessionListResult = {
  sessions?: SessionRow[];
};

export type SessionDescribeResult = {
  session?: SessionRow | null;
};

export type ChatHistoryResult = {
  messages?: Array<{ id?: string; role?: string; content?: unknown; [key: string]: unknown }>;
};

export type SessionMessagePayload = {
  sessionKey?: string;
  senderIsOwner?: boolean;
  messageId?: string;
  messageSeq?: number;
  message?: { role?: string; content?: unknown; [key: string]: unknown };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  [key: string]: unknown;
};

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export type PendingApproval = {
  kind: ChannelApprovalKind;
  id: string;
  request?: Record<string, unknown>;
  createdAtMs?: number;
  expiresAtMs?: number;
};

export type QueueEvent =
  | {
      cursor: number;
      type: "message";
      sessionKey: string;
      conversation?: ConversationDescriptor;
      messageId?: string;
      messageSeq?: number;
      role?: string;
      text?: string;
      raw: SessionMessagePayload;
    }
  | {
      cursor: number;
      type: "claude_permission_request";
      requestId: string;
      toolName: string;
      description: string;
      inputPreview: string;
    }
  | {
      cursor: number;
      type: "exec_approval_requested" | "exec_approval_resolved";
      raw: Record<string, unknown>;
    }
  | {
      cursor: number;
      type: "plugin_approval_requested" | "plugin_approval_resolved";
      raw: Record<string, unknown>;
    };

export type WaitFilter = {
  afterCursor: number;
  sessionKey?: string;
};

/** Retained queue boundary reported when a requested cursor can no longer be replayed. */
export type EventCursorGap = {
  requested_after_cursor: number;
  oldest_available_cursor: number;
};

export type EventPollResult = {
  events: QueueEvent[];
  nextCursor: number;
  gap?: EventCursorGap;
};

export type EventWaitResult = {
  event: QueueEvent | null;
  gap?: EventCursorGap;
};

export const ClaudePermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

export { toText };

export function summarizeResult(
  label: string,
  count: number,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: `${label}: ${count}` }],
  };
}

export function summarizeStructuredResult(
  label: string,
  count: number,
  payload: unknown,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: `${label}: ${count}\n\n${JSON.stringify(payload, null, 2)}` }],
  };
}

/** Convert a Gateway session row into a reply-capable conversation descriptor. */
export function toConversation(row: SessionRow): ConversationDescriptor | null {
  const channel = normalizeOptionalLowercaseString(
    toText(row.deliveryContext?.channel) ??
      toText(row.lastChannel) ??
      toText(row.channel) ??
      toText(row.origin?.provider),
  );
  const to = toText(row.deliveryContext?.to) ?? toText(row.lastTo);
  if (!channel || !to) {
    return null;
  }
  return {
    sessionKey: row.key,
    channel,
    to,
    accountId:
      toText(row.deliveryContext?.accountId) ??
      toText(row.lastAccountId) ??
      toText(row.origin?.accountId),
    threadId: row.deliveryContext?.threadId ?? row.lastThreadId ?? row.origin?.threadId,
    label: toText(row.label),
    displayName: toText(row.displayName),
    derivedTitle: toText(row.derivedTitle),
    lastMessagePreview: toText(row.lastMessagePreview),
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
  };
}

export function matchEventFilter(event: QueueEvent, filter: WaitFilter): boolean {
  if (event.cursor <= filter.afterCursor) {
    return false;
  }
  if (!filter.sessionKey) {
    return true;
  }
  return "sessionKey" in event && event.sessionKey === filter.sessionKey;
}

/** Return non-text content blocks plus canonical persisted media from a raw message payload. */
export function extractAttachmentsFromMessage(message: unknown): unknown[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  const contentAttachments = Array.isArray(content)
    ? content.filter((entry) => {
        if (!entry || typeof entry !== "object") {
          return false;
        }
        return toText((entry as { type?: unknown }).type) !== "text";
      })
    : [];
  const mediaAttachments = (readPersistedMediaFacts(message) ?? [])
    .filter(isMeaningfulMediaFact)
    .map((media) => ({
      type: "openclaw_media" as const,
      media: Object.fromEntries(Object.entries(media).filter(([, value]) => value !== undefined)),
    }));
  return [...contentAttachments, ...mediaAttachments];
}
