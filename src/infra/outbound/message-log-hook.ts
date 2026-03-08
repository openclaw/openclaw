/**
 * message-log-hook.ts — Fire-and-forget helper that logs outbound messages
 * to the `message_log` SQLite table via the memory manager.
 */

import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { logMessage } from "../../memory/message-logger.js";
import type { OutboundSendContext } from "./outbound-send-service.js";

export async function logOutboundMessageToDb(params: {
  ctx: OutboundSendContext;
  to: string;
  message: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  threadId?: string | number;
}): Promise<void> {
  const sessionKey = params.ctx.mirror?.sessionKey;
  if (!sessionKey) {
    return;
  }

  const cfg = params.ctx.cfg;
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
    direction: "outbound",
    role: "assistant",
    channel: params.ctx.channel ? String(params.ctx.channel).toLowerCase() : undefined,
    accountId: params.ctx.accountId ?? undefined,
    recipient: params.to,
    body: params.message || undefined,
    mediaUrl: params.mediaUrl ?? undefined,
    mediaUrls: params.mediaUrls ?? undefined,
    replyToId: params.replyToId ?? undefined,
    threadId: params.threadId != null ? String(params.threadId) : undefined,
  });
}
