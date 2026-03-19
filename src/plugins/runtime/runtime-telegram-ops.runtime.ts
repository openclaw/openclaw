import { auditTelegramGroupMembership as auditTelegramGroupMembershipImpl } from "openclaw/plugin-sdk/telegram";
import { monitorTelegramProvider as monitorTelegramProviderImpl } from "openclaw/plugin-sdk/telegram";
import { probeTelegram as probeTelegramImpl } from "openclaw/plugin-sdk/telegram";
import {
  deleteMessageTelegram as deleteMessageTelegramImpl,
  editMessageReplyMarkupTelegram as editMessageReplyMarkupTelegramImpl,
  editMessageTelegram as editMessageTelegramImpl,
  pinMessageTelegram as pinMessageTelegramImpl,
  renameForumTopicTelegram as renameForumTopicTelegramImpl,
  sendMessageTelegram as sendMessageTelegramImpl,
  sendPollTelegram as sendPollTelegramImpl,
  sendTypingTelegram as sendTypingTelegramImpl,
  unpinMessageTelegram as unpinMessageTelegramImpl,
} from "openclaw/plugin-sdk/telegram";
import type { PluginRuntimeChannel } from "./types-channel.js";

type RuntimeTelegramOps = Pick<
  PluginRuntimeChannel["telegram"],
  | "auditGroupMembership"
  | "probeTelegram"
  | "sendMessageTelegram"
  | "sendPollTelegram"
  | "monitorTelegramProvider"
> & {
  typing: Pick<PluginRuntimeChannel["telegram"]["typing"], "pulse">;
  conversationActions: Pick<
    PluginRuntimeChannel["telegram"]["conversationActions"],
    | "editMessage"
    | "editReplyMarkup"
    | "deleteMessage"
    | "renameTopic"
    | "pinMessage"
    | "unpinMessage"
  >;
};

export const runtimeTelegramOps = {
  auditGroupMembership: auditTelegramGroupMembershipImpl,
  probeTelegram: probeTelegramImpl,
  sendMessageTelegram: sendMessageTelegramImpl,
  sendPollTelegram: sendPollTelegramImpl,
  monitorTelegramProvider: monitorTelegramProviderImpl,
  typing: {
    pulse: sendTypingTelegramImpl,
  },
  conversationActions: {
    editMessage: editMessageTelegramImpl,
    editReplyMarkup: editMessageReplyMarkupTelegramImpl,
    deleteMessage: deleteMessageTelegramImpl,
    renameTopic: renameForumTopicTelegramImpl,
    pinMessage: pinMessageTelegramImpl,
    unpinMessage: unpinMessageTelegramImpl,
  },
} satisfies RuntimeTelegramOps;
