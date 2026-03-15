/**
 * message-log-hook.ts — Fire-and-forget helper that logs inbound messages
 * to the `message_log` SQLite table via the memory manager.
 */

import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { logMessage } from "../../memory/message-logger.js";
import type { FinalizedMsgContext } from "../templating.js";

export async function logInboundMessageToDb(
  ctx: FinalizedMsgContext,
  sessionKey: string,
  content: string,
  cfg: OpenClawConfig,
): Promise<void> {
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const { manager } = await getMemorySearchManager({ cfg, agentId });
  if (!manager) {
    return;
  }

  const db = (manager as { db?: import("node:sqlite").DatabaseSync }).db;
  if (!db) {
    return;
  }

  logMessage({
    db,
    sessionKey,
    direction: "inbound",
    role: "user",
    channel: (ctx.Surface ?? ctx.Provider ?? undefined)?.toLowerCase(),
    accountId: ctx.AccountId ?? undefined,
    senderId: ctx.SenderId ?? ctx.SenderE164 ?? ctx.From ?? undefined,
    senderName: ctx.SenderName ?? undefined,
    recipient: ctx.To ?? undefined,
    body: content || undefined,
    mediaUrl: ctx.MediaUrl ?? undefined,
    mediaType: ctx.MediaType ?? undefined,
    mediaUrls: ctx.MediaUrls ?? undefined,
    chatType: ctx.ChatType ?? undefined,
    groupSubject: ctx.GroupSubject ?? undefined,
    threadId: ctx.MessageThreadId != null ? String(ctx.MessageThreadId) : undefined,
    replyToId: ctx.ReplyToId ?? undefined,
    messageSid: ctx.MessageSidFull ?? ctx.MessageSid ?? undefined,
  });
}
