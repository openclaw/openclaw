/**
 * Conv-Raw Bridge — thin shim for bot reply logging.
 *
 * dispatch-from-config.ts cannot use the message_sent plugin hook because
 * Feishu's reply dispatcher bypasses deliverOutboundPayloads entirely.
 * This bridge reaches into the active context engine (if it's conv-raw)
 * to log bot replies directly, without hard-importing the plugin.
 *
 * Safe to call even when conv-raw is not installed — returns silently.
 */

import type { OpenClawConfig } from "../config/config.js";
import { resolveContextEngine } from "../context-engine/registry.js";

type ConvRawEngineCompat = {
  logBotReply?: (params: {
    chatId: string;
    content: string;
    channel: string;
    timestamp: number;
  }) => void;
};

export async function tryLogConvRawBotReply(params: {
  chatId: string;
  content: string;
  channel: string;
  timestamp: number;
  cfg?: OpenClawConfig;
}): Promise<void> {
  try {
    const engine = await resolveContextEngine(params.cfg);
    const compat = engine as unknown as ConvRawEngineCompat;
    if (typeof compat.logBotReply === "function") {
      compat.logBotReply({
        chatId: params.chatId,
        content: params.content,
        channel: params.channel,
        timestamp: params.timestamp,
      });
    } else {
      console.warn(`[Conv-Raw-Bridge] engine "${engine.info?.id}" has no logBotReply`);
    }
  } catch (err) {
    console.warn(`[Conv-Raw-Bridge] tryLogConvRawBotReply failed: ${String(err)}`);
  }
}
