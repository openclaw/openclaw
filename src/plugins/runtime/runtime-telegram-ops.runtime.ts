import {
  auditTelegramGroupMembership as auditTelegramGroupMembershipImpl,
  monitorTelegramProvider as monitorTelegramProviderImpl,
  probeTelegram as probeTelegramImpl,
} from "../../plugin-sdk/telegram.js";
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
} from "../../plugin-sdk/telegram.js";
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
