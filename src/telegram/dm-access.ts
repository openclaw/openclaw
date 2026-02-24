import type { Message } from "@grammyjs/types";
import type { Bot } from "grammy";
import type { DmPolicy } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { buildPairingReply } from "../pairing/pairing-messages.js";
import { upsertChannelPairingRequest } from "../pairing/pairing-store.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { resolveSenderAllowMatch, type NormalizedAllowFrom } from "./bot-access.js";

type TelegramDmAccessLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
};

export async function enforceTelegramDmAccess(params: {
  isGroup: boolean;
  dmPolicy: DmPolicy;
  msg: Message;
  chatId: number;
  effectiveDmAllow: NormalizedAllowFrom;
  accountId: string;
  bot: Bot;
  logger: TelegramDmAccessLogger;
}): Promise<boolean> {
  const { isGroup, dmPolicy, msg, chatId, effectiveDmAllow, accountId, bot, logger } = params;
  if (isGroup) {
    return true;
  }
  if (dmPolicy === "disabled") {
    return false;
  }
  if (dmPolicy === "open") {
    return true;
  }

  const senderUsername = msg.from?.username ?? "";
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const candidate = senderUserId ?? String(chatId);
  const allowMatch = resolveSenderAllowMatch({
    allow: effectiveDmAllow,
    senderId: candidate,
    senderUsername,
  });
  const allowMatchMeta = `matchKey=${allowMatch.matchKey ?? "none"} matchSource=${
    allowMatch.matchSource ?? "none"
  }`;
  const allowed =
    effectiveDmAllow.hasWildcard || (effectiveDmAllow.hasEntries && allowMatch.allowed);
  if (allowed) {
    return true;
  }

  if (dmPolicy === "pairing") {
    try {
      const from = msg.from as
        | {
            first_name?: string;
            last_name?: string;
            username?: string;
            id?: number;
          }
        | undefined;
      const telegramUserId = from?.id ? String(from.id) : candidate;
      const { code, created } = await upsertChannelPairingRequest({
        channel: "telegram",
        id: telegramUserId,
        accountId,
        meta: {
          username: from?.username,
          firstName: from?.first_name,
          lastName: from?.last_name,
        },
      });
      if (created) {
        logger.info(
          {
            chatId: String(chatId),
            senderUserId: senderUserId ?? undefined,
            username: from?.username,
            firstName: from?.first_name,
            lastName: from?.last_name,
            matchKey: allowMatch.matchKey ?? "none",
            matchSource: allowMatch.matchSource ?? "none",
          },
          "telegram pairing request",
        );
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          fn: () =>
            bot.api.sendMessage(
              chatId,
              buildPairingReply({
                channel: "telegram",
                idLine: `Your Telegram user id: ${telegramUserId}`,
                code,
              }),
            ),
        });
      }
    } catch (err) {
      logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
    }
    return false;
  }

  logVerbose(
    `Blocked unauthorized telegram sender ${candidate} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
  );
  return false;
}
