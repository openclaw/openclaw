import type { LinqSendResult } from "./types.js";
import { loadConfig } from "../config/config.js";
import { resolveLinqAccount, type ResolvedLinqAccount } from "./accounts.js";

const LINQ_API_BASE = "https://api.linqapp.com/api/partner/v3";
const UA = "OpenClaw/1.0";

export type LinqSendOpts = {
  accountId?: string;
  mediaUrl?: string;
  replyToMessageId?: string;
  verbose?: boolean;
  token?: string;
  config?: ReturnType<typeof loadConfig>;
  account?: ResolvedLinqAccount;
};

/**
 * Send a message via Linq Blue V3 API.
 *
 * @param to - Chat ID (Linq chat_id) to send to.
 * @param text - Message text.
 * @param opts - Optional send options.
 */
export async function sendMessageLinq(
  to: string,
  text: string,
  opts: LinqSendOpts = {},
): Promise<LinqSendResult> {
  const cfg = opts.config ?? loadConfig();
  const account = opts.account ?? resolveLinqAccount({ cfg, accountId: opts.accountId });
  const token = opts.token?.trim() || account.token;
  if (!token) {
    throw new Error("Linq API token not configured");
  }

  const parts: Array<Record<string, unknown>> = [];
  if (text) {
    parts.push({ type: "text", value: text });
  }
  if (opts.mediaUrl?.trim()) {
    parts.push({ type: "media", url: opts.mediaUrl.trim() });
  }
  if (parts.length === 0) {
    throw new Error("Linq send requires text or media");
  }

  const message: Record<string, unknown> = { parts };
  if (opts.replyToMessageId?.trim()) {
    message.reply_to = { message_id: opts.replyToMessageId.trim() };
  }

  const url = `${LINQ_API_BASE}/chats/${encodeURIComponent(to)}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Linq API error: ${response.status} ${errorText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    chat_id?: string;
    message?: { id?: string };
  };
  return {
    messageId: data.message?.id ?? "unknown",
    chatId: data.chat_id ?? to,
  };
}

/** Send a typing indicator. */
export async function startTypingLinq(chatId: string, token: string): Promise<void> {
  const url = `${LINQ_API_BASE}/chats/${encodeURIComponent(chatId)}/typing`;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
}

/** Clear a typing indicator. */
export async function stopTypingLinq(chatId: string, token: string): Promise<void> {
  const url = `${LINQ_API_BASE}/chats/${encodeURIComponent(chatId)}/typing`;
  await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
}

/** Mark a chat as read. */
export async function markAsReadLinq(chatId: string, token: string): Promise<void> {
  const url = `${LINQ_API_BASE}/chats/${encodeURIComponent(chatId)}/read`;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
}

/** Send a reaction to a message. */
export async function sendReactionLinq(
  messageId: string,
  type: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question",
  token: string,
  operation: "add" | "remove" = "add",
): Promise<void> {
  const url = `${LINQ_API_BASE}/messages/${encodeURIComponent(messageId)}/reactions`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ operation, type }),
  });
}
