import { chunkText } from "../auto-reply/chunk.js";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { resolveMessengerAccount } from "./accounts.js";
import { GRAPH_API_BASE, type MessengerSendResult } from "./types.js";

interface MessengerSendOpts {
  pageAccessToken?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  mediaType?: "image" | "video" | "audio" | "file";
}

function resolveToken(
  explicit: string | undefined,
  params: { accountId: string; pageAccessToken: string },
): string {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (!params.pageAccessToken) {
    throw new Error(
      `Messenger page access token missing for account "${params.accountId}" (set channels.messenger.pageAccessToken or MESSENGER_PAGE_ACCESS_TOKEN).`,
    );
  }
  return params.pageAccessToken.trim();
}

function normalizeTarget(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Messenger sends");
  }
  return trimmed.replace(/^messenger:/i, "");
}

async function graphApiSend(
  token: string,
  body: Record<string, unknown>,
): Promise<{ message_id?: string }> {
  const res = await fetch(`${GRAPH_API_BASE}/me/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Messenger API ${res.status}: ${text.slice(0, 500)}`);
  }

  return (await res.json()) as { message_id?: string };
}

export async function sendMessageMessenger(
  to: string,
  text: string,
  opts: MessengerSendOpts = {},
): Promise<MessengerSendResult> {
  const cfg = loadConfig();
  const account = resolveMessengerAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.pageAccessToken, account);
  const chatId = normalizeTarget(to);
  const mediaUrl = opts.mediaUrl?.trim();
  const messageText = text?.trim();

  // Send media if provided
  if (mediaUrl) {
    await sendMediaMessenger(chatId, mediaUrl, {
      pageAccessToken: token,
      accountId: account.accountId,
      mediaType: opts.mediaType ?? "image",
    });
  }

  // Send text message
  if (messageText) {
    // Split text into 2000-char chunks (Messenger limit)
    const chunks = chunkText(messageText, 2000);

    let lastResult: { message_id?: string } = {};
    for (const chunk of chunks) {
      lastResult = await graphApiSend(token, {
        recipient: { id: chatId },
        messaging_type: "RESPONSE",
        message: { text: chunk },
      });
    }

    recordChannelActivity({
      channel: "messenger",
      accountId: account.accountId,
      direction: "outbound",
    });

    if (opts.verbose) {
      logVerbose(`messenger: sent message to ${chatId}`);
    }

    return {
      messageId: lastResult.message_id ?? "sent",
      chatId,
    };
  }

  if (!mediaUrl) {
    throw new Error("Message must be non-empty for Messenger sends");
  }

  return { messageId: "media", chatId };
}

export async function sendMediaMessenger(
  to: string,
  mediaUrl: string,
  opts: {
    pageAccessToken?: string;
    accountId?: string;
    mediaType?: "image" | "video" | "audio" | "file";
  } = {},
): Promise<MessengerSendResult> {
  const normalizedMediaUrl = mediaUrl.trim();
  if (!normalizedMediaUrl) {
    throw new Error("mediaUrl must be non-empty for Messenger sends");
  }

  const cfg = loadConfig();
  const account = resolveMessengerAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.pageAccessToken, account);
  const chatId = normalizeTarget(to);
  const attachmentType = opts.mediaType ?? "image";

  const result = await graphApiSend(token, {
    recipient: { id: chatId },
    messaging_type: "RESPONSE",
    message: {
      attachment: {
        type: attachmentType,
        payload: {
          url: normalizedMediaUrl,
          is_reusable: true,
        },
      },
    },
  });

  recordChannelActivity({
    channel: "messenger",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: result.message_id ?? "media",
    chatId,
  };
}

export async function sendSenderAction(
  to: string,
  action: "mark_seen" | "typing_on" | "typing_off",
  opts: { pageAccessToken?: string; accountId?: string } = {},
): Promise<void> {
  const cfg = loadConfig();
  const account = resolveMessengerAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.pageAccessToken, account);
  const chatId = normalizeTarget(to);

  try {
    await fetch(`${GRAPH_API_BASE}/me/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        recipient: { id: chatId },
        sender_action: action,
      }),
    });
  } catch (err) {
    logVerbose(`messenger: sender action ${action} failed (non-fatal): ${String(err)}`);
  }
}

export async function getUserProfile(
  userId: string,
  opts: { pageAccessToken?: string; accountId?: string } = {},
): Promise<{ first_name?: string; last_name?: string; profile_pic?: string } | null> {
  const cfg = loadConfig();
  const account = resolveMessengerAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.pageAccessToken, account);

  try {
    const res = await fetch(`${GRAPH_API_BASE}/${userId}?fields=first_name,last_name,profile_pic`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as {
      first_name?: string;
      last_name?: string;
      profile_pic?: string;
    };
  } catch (err) {
    logVerbose(`messenger: failed to fetch profile for ${userId}: ${String(err)}`);
    return null;
  }
}
