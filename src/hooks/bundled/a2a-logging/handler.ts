/**
 * Agent-to-Agent Logging Hook Handler
 *
 * Posts formatted log entries to a Telegram topic when agents
 * communicate via sessions_send, providing real-time visibility
 * into inter-agent messaging.
 */

import { loadConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveTelegramToken } from "../../../telegram/token.js";
import { resolveHookConfig } from "../../config.js";
import type { InternalHookHandler } from "../../internal-hooks.js";

const log = createSubsystemLogger("a2a-logging");

const warningSuppressed = new Set<string>();

export type A2ALoggingConfig = {
  enabled?: boolean;
  chatId?: string;
  topicId?: number;
  token?: string;
};

export function resolveA2AConfig(): A2ALoggingConfig | undefined {
  const cfg = loadConfig();
  const hookConfig = resolveHookConfig(cfg, "a2a-logging");
  if (!hookConfig || hookConfig.enabled === false) {
    return undefined;
  }
  return hookConfig as A2ALoggingConfig;
}

export function resolveToken(hookToken: string | undefined): string {
  if (hookToken) {
    return hookToken;
  }
  try {
    const cfg = loadConfig();
    const resolved = resolveTelegramToken(cfg);
    return resolved.token;
  } catch {
    return "";
  }
}

export function formatA2ALogMessage(
  sourceAgentId: string,
  targetAgentId: string,
  message: string,
  timestamp: Date,
): string {
  const time = formatTimestamp(timestamp);
  const preview = truncateMessage(message, 200);
  return `<code>[${time}]</code> <b>${escapeHtml(sourceAgentId)}</b> -> <b>${escapeHtml(targetAgentId)}</b>\n${escapeHtml(preview)}`;
}

function formatTimestamp(date: Date): string {
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function truncateMessage(msg: string, maxLen: number): string {
  if (msg.length <= maxLen) {
    return msg;
  }
  return msg.slice(0, maxLen) + "...";
}

export async function postToTelegram(
  token: string,
  chatId: string,
  topicId: number | undefined,
  text: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_notification: true,
  };
  if (topicId !== undefined) {
    body.message_thread_id = topicId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Telegram API ${response.status}: ${errorBody}`);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const handler: InternalHookHandler = async (event) => {
  if (event.type !== "agent_to_agent" || event.action !== "send") {
    return;
  }

  try {
    const config = resolveA2AConfig();
    if (!config) {
      return;
    }

    const { chatId, topicId } = config;
    if (!chatId) {
      if (!warningSuppressed.has("chatId")) {
        log.warn(
          "a2a-logging enabled but chatId not configured. Set hooks.internal.entries.a2a-logging.chatId",
        );
        warningSuppressed.add("chatId");
      }
      return;
    }

    const token = resolveToken(config.token);
    if (!token) {
      if (!warningSuppressed.has("token")) {
        log.warn(
          "a2a-logging enabled but no Telegram bot token found. Set hooks.internal.entries.a2a-logging.token or configure channels.telegram.botToken",
        );
        warningSuppressed.add("token");
      }
      return;
    }

    const ctx = event.context as {
      sourceAgentId?: string;
      targetAgentId?: string;
      message?: string;
    };

    const source = ctx.sourceAgentId ?? "unknown";
    const target = ctx.targetAgentId ?? "unknown";
    const msg = ctx.message ?? "";

    const text = formatA2ALogMessage(source, target, msg, event.timestamp);
    await postToTelegram(token, chatId, topicId, text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Failed to log A2A message: ${message}`);
  }
};

export default handler;
