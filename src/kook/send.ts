// KOOK Message Sending

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadConfig } from "../config/io.js";
import { resolveKookAccount } from "./accounts.js";
import {
  sendKookMessage as apiSendKookMessage,
  sendKookDirectMessage as apiSendKookDirectMessage,
} from "./api.js";
import { resolveKookToken } from "./token.js";

export type KookSendOpts = {
  accountId?: string;
  token?: string;
  type?: 1 | 9 | 10; // 1=text, 9=kmarkdown, 10=card
  quote?: string; // Reply to message ID
  nonce?: string;
};

export type KookSendResult = {
  channel: "kook";
  messageId: string;
  timestamp: number;
};

/**
 * Parse target string to extract targetId and channel type
 */
function parseTarget(to: string): { targetId: string; isDm: boolean } {
  // Format: "user:<id>" for DM, "channel:<id>" or just "<id>" for channel
  if (to.startsWith("user:")) {
    return { targetId: to.slice(5), isDm: true };
  }
  if (to.startsWith("channel:")) {
    return { targetId: to.slice(8), isDm: false };
  }
  return { targetId: to, isDm: false };
}

/**
 * Send a text message to KOOK channel or user
 * Alias for sendMessageKook for backward compatibility
 */
/**
 * Send a text message to KOOK channel or user
 * Alias for sendMessageKook for backward compatibility
 */
export async function sendKookMessage(
  to: string,
  text: string,
  opts: KookSendOpts = {},
  cfg?: OpenClawConfig,
): Promise<KookSendResult> {
  return sendMessageKook(to, text, opts, cfg);
}

/**
 * Send a text message to KOOK channel or user
 */
export async function sendMessageKook(
  to: string,
  text: string,
  opts: KookSendOpts = {},
  cfg?: OpenClawConfig,
): Promise<KookSendResult> {
  // Get token from opts or resolve from config
  let token = opts.token || "";

  // If no token in opts, resolve from config
  if (!token) {
    // Ensure we have a valid config (either provided or loaded from file)
    let effectiveCfg = cfg;
    if (!effectiveCfg) {
      try {
        effectiveCfg = loadConfig();
      } catch {
        // Config file not found, will try env below
      }
    }

    // If cfg is provided (or loaded), use it to resolve token
    if (effectiveCfg) {
      const account = resolveKookAccount({ cfg: effectiveCfg, accountId: opts.accountId });
      token = account.token || "";
    } else {
      // If cfg is missing, use direct token resolution (will try env)
      const tokenRes = resolveKookToken(undefined, { accountId: opts.accountId });
      token = tokenRes.token;
    }
  }

  // Final check
  if (!token) {
    throw new Error("KOOK token not found");
  }

  const { targetId, isDm } = parseTarget(to);
  const type = opts.type || 1; // Default to text

  // Send message using API functions
  const sendFn = isDm ? apiSendKookDirectMessage : apiSendKookMessage;

  const result = await sendFn({
    token,
    type,
    targetId,
    content: text,
    quote: opts.quote,
    nonce: opts.nonce,
  });

  return {
    channel: "kook",
    messageId: result.msgId,
    timestamp: result.msgTimestamp,
  };
}

/**
 * Send a direct message (convenience wrapper)
 */
export async function sendDirectMessageKook(
  userId: string,
  text: string,
  opts: KookSendOpts = {},
  cfg?: OpenClawConfig,
): Promise<KookSendResult> {
  return sendMessageKook(`user:${userId}`, text, opts, cfg);
}
