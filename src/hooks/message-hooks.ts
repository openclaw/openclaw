/**
 * Message hook events for message:received and message:sent
 *
 * These hooks enable automation around the message lifecycle:
 * - message:received — fires when an inbound message is about to be processed
 * - message:sent — fires after an outbound message is successfully delivered
 */

import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { createInternalHookEvent, triggerInternalHook } from "./internal-hooks.js";

export type MessageReceivedContext = {
  /** The finalized inbound message context */
  message: string;
  /** Raw message body before envelope formatting */
  rawBody?: string;
  /** Sender identifier (phone, username, etc.) */
  senderId?: string;
  /** Sender display name */
  senderName?: string;
  /** Channel the message came from (signal, telegram, etc.) */
  channel?: string;
  /** Platform message ID */
  messageId?: string;
  /** Whether this is a group message */
  isGroup?: boolean;
  /** Group ID if applicable */
  groupId?: string;
  /** Timestamp of the message */
  timestamp?: number;
  /** Whether the sender is authorized for commands */
  commandAuthorized?: boolean;
};

export type MessageSentContext = {
  /** The reply text that was sent */
  text?: string;
  /** Media URL if any */
  mediaUrl?: string;
  /** Target recipient */
  target?: string;
  /** Channel the message was sent to */
  channel?: string;
  /** Delivery kind (tool, block, final) */
  kind?: string;
};

/**
 * Trigger message:received hook
 * Call this when an inbound message is about to be processed by the agent
 */
export async function triggerMessageReceived(
  sessionKey: string,
  ctx: FinalizedMsgContext,
): Promise<void> {
  const hookEvent = createInternalHookEvent("message", "received", sessionKey, {
    message: ctx.Body ?? "",
    rawBody: ctx.RawBody,
    senderId: ctx.SenderId,
    senderName: ctx.SenderName,
    channel: ctx.Provider,
    messageId: ctx.MessageSid,
    isGroup: ctx.ChatType === "group",
    groupId: ctx.ChatType === "group" ? ctx.From : undefined,
    timestamp: ctx.Timestamp,
    commandAuthorized: ctx.CommandAuthorized,
  } satisfies MessageReceivedContext);

  await triggerInternalHook(hookEvent);
}

/**
 * Trigger message:sent hook
 * Call this after an outbound message is successfully delivered
 */
export async function triggerMessageSent(
  sessionKey: string,
  payload: ReplyPayload,
  context: { target?: string; channel?: string; kind?: string },
): Promise<void> {
  const hookEvent = createInternalHookEvent("message", "sent", sessionKey, {
    text: payload.text,
    mediaUrl: payload.mediaUrl,
    target: context.target,
    channel: context.channel,
    kind: context.kind,
  } satisfies MessageSentContext);

  await triggerInternalHook(hookEvent);
}
