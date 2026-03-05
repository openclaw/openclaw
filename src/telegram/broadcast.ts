import type { Bot } from "grammy";
import type { ReplyToMode } from "../config/config.js";
import type { OpenClawConfig, TelegramAccountConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { buildAgentSessionKey } from "../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramStreamMode } from "./bot/types.js";

export type MaybeBroadcastTelegramMessageParams = {
  cfg: OpenClawConfig;
  context: TelegramMessageContext;
  bot: Bot;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  opts: Pick<TelegramBotOptions, "token">;
};

/**
 * If the sender's peer ID is configured for broadcast, dispatch the message
 * to every listed agent and return `true`.  Returns `false` when no broadcast
 * config matches — the caller should continue with normal single-agent dispatch.
 */
export async function maybeBroadcastTelegramMessage(
  params: MaybeBroadcastTelegramMessageParams,
): Promise<boolean> {
  const { cfg, context } = params;
  const chatId = String(context.chatId);

  // Try account-scoped key first, then "telegram:{chatId}" (prefixed), then raw "{chatId}".
  const accountId = context.accountId ?? context.route.accountId;
  const broadcastAgents =
    cfg.broadcast?.[`telegram:${accountId}:${chatId}`] ??
    cfg.broadcast?.[`telegram:${chatId}`] ??
    cfg.broadcast?.[chatId];
  if (!broadcastAgents || !Array.isArray(broadcastAgents)) {
    return false;
  }
  if (broadcastAgents.length === 0) {
    return false;
  }

  const strategy = cfg.broadcast?.strategy || "parallel";
  logVerbose(
    `telegram broadcast: fanning message to ${broadcastAgents.length} agents (${strategy})`,
  );

  const agentIds = cfg.agents?.list?.map((agent) => normalizeAgentId(agent.id));
  const hasKnownAgents = (agentIds?.length ?? 0) > 0;
  const isGroup = context.isGroup;
  const peerId = context.ctxPayload.From?.replace(/^telegram:/, "") ?? chatId;

  // Snapshot group history before dispatch so every agent sees the same context.
  const groupHistorySnapshot =
    isGroup && context.historyKey
      ? (context.groupHistories.get(context.historyKey) ?? [])
      : undefined;

  let isFirstAgent = true;

  const dispatchForAgent = async (agentId: string): Promise<boolean> => {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (hasKnownAgents && !agentIds?.includes(normalizedAgentId)) {
      logVerbose(`telegram broadcast: agent ${agentId} not found in agents.list; skipping`);
      return false;
    }

    const agentRoute = {
      ...context.route,
      agentId: normalizedAgentId,
      sessionKey: buildAgentSessionKey({
        agentId: normalizedAgentId,
        channel: "telegram",
        accountId: context.route.accountId,
        peer: {
          kind: isGroup ? "group" : ("direct" as const),
          id: peerId,
        },
        dmScope: cfg.session?.dmScope,
        identityLinks: cfg.session?.identityLinks,
      }),
      mainSessionKey: buildAgentMainSessionKey({
        agentId: normalizedAgentId,
        mainKey: DEFAULT_MAIN_KEY,
      }),
    };

    const isPrimary = isFirstAgent;
    isFirstAgent = false;

    const broadcastContext: TelegramMessageContext = {
      ...context,
      route: agentRoute,
      // Only the first/primary agent should send the ack reaction, remove it
      // after reply, or drive status reaction lifecycle.
      ...(isPrimary
        ? {}
        : {
            ackReactionPromise: null,
            reactionApi: null,
            removeAckAfterReply: false,
            statusReactionController: null,
          }),
      // Each agent gets its own copy of group history so dispatch doesn't
      // clear shared state prematurely.
      ...(groupHistorySnapshot != null
        ? {
            groupHistories: new Map(context.groupHistories),
          }
        : {}),
    };

    try {
      await dispatchTelegramMessage({
        context: broadcastContext,
        bot: params.bot,
        cfg: params.cfg,
        runtime: params.runtime,
        replyToMode: params.replyToMode,
        streamMode: params.streamMode,
        textLimit: params.textLimit,
        telegramCfg: params.telegramCfg,
        opts: params.opts,
      });
      return true;
    } catch (err) {
      logVerbose(`telegram broadcast: agent ${agentId} failed: ${String(err)}`);
      return false;
    }
  };

  if (strategy === "sequential") {
    for (const agentId of broadcastAgents) {
      await dispatchForAgent(agentId);
    }
  } else {
    await Promise.allSettled(broadcastAgents.map(dispatchForAgent));
  }

  // Clear group history after all agents have processed (mirrors WhatsApp behavior).
  if (isGroup && context.historyKey) {
    context.groupHistories.set(context.historyKey, []);
  }

  return true;
}
