/**
 * Zalo message sending utilities
 */

import type { ClawdbotConfig } from "../config/config.js";
import { sendMessage, sendPhoto } from "./api.js";
import { resolveZaloToken } from "./token.js";

export type ZaloSendOptions = {
  token?: string;
  accountId?: string;
  cfg?: ClawdbotConfig;
  mediaUrl?: string;
  caption?: string;
  verbose?: boolean;
};

export type ZaloSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

/**
 * Resolve the token to use for sending
 */
function resolveToken(options: ZaloSendOptions): string {
  if (options.token) {
    return options.token;
  }

  if (options.cfg) {
    const { token } = resolveZaloToken(options.cfg, options.accountId);
    return token;
  }

  // Fallback to env
  return process.env.ZALO_BOT_TOKEN?.trim() ?? "";
}

/**
 * Send a text message to a Zalo chat
 */
export async function sendMessageZalo(
  chatId: string,
  text: string,
  options: ZaloSendOptions = {},
): Promise<ZaloSendResult> {
  const token = resolveToken(options);

  if (!token) {
    return {
      ok: false,
      error: "No Zalo bot token configured",
    };
  }

  if (!chatId?.trim()) {
    return {
      ok: false,
      error: "No chat_id provided",
    };
  }

  // Handle media if provided
  if (options.mediaUrl) {
    return sendPhotoZalo(chatId, options.mediaUrl, {
      ...options,
      token,
      caption: text || options.caption,
    });
  }

  try {
    const response = await sendMessage(token, {
      chat_id: chatId.trim(),
      text: text.slice(0, 2000), // Enforce 2000 char limit
    });

    if (response.ok && response.result) {
      return {
        ok: true,
        messageId: response.result.message_id,
      };
    }

    return {
      ok: false,
      error: "Failed to send message",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Send a photo message to a Zalo chat
 */
export async function sendPhotoZalo(
  chatId: string,
  photoUrl: string,
  options: ZaloSendOptions = {},
): Promise<ZaloSendResult> {
  const token = options.token ?? resolveToken(options);

  if (!token) {
    return {
      ok: false,
      error: "No Zalo bot token configured",
    };
  }

  if (!chatId?.trim()) {
    return {
      ok: false,
      error: "No chat_id provided",
    };
  }

  if (!photoUrl?.trim()) {
    return {
      ok: false,
      error: "No photo URL provided",
    };
  }

  try {
    const response = await sendPhoto(token, {
      chat_id: chatId.trim(),
      photo: photoUrl.trim(),
      caption: options.caption?.slice(0, 2000),
    });

    if (response.ok && response.result) {
      return {
        ok: true,
        messageId: response.result.message_id,
      };
    }

    return {
      ok: false,
      error: "Failed to send photo",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
