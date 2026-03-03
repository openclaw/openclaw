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

type TelegramSenderIdentity = {
  username: string;
  userId: string | null;
  candidateId: string;
  firstName?: string;
  lastName?: string;
};

function resolveTelegramSenderIdentity(msg: Message, chatId: number): TelegramSenderIdentity {
  const from = msg.from;
  const userId = from?.id != null ? String(from.id) : null;
  return {
    username: from?.username ?? "",
    userId,
    candidateId: userId ?? String(chatId),
    firstName: from?.first_name,
    lastName: from?.last_name,
  };
}

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

  const sender = resolveTelegramSenderIdentity(msg, chatId);
  const allowMatch = resolveSenderAllowMatch({
    allow: effectiveDmAllow,
    senderId: sender.candidateId,
    senderUsername: sender.username,
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
      const telegramUserId = sender.userId ?? sender.candidateId;
      const { code, created } = await upsertChannelPairingRequest({
        channel: "telegram",
        id: telegramUserId,
        accountId,
        meta: {
          username: sender.username || undefined,
          firstName: sender.firstName,
          lastName: sender.lastName,
        },
      });
      if (created) {
        logger.info(
          {
            chatId: String(chatId),
            senderUserId: sender.userId ?? undefined,
            username: sender.username || undefined,
            firstName: sender.firstName,
            lastName: sender.lastName,
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
    `Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
  );
  return false;
}
