import {
  auditTelegramGroupMembership,
  collectTelegramUnmentionedGroupIds,
} from "../../../extensions/telegram/src/audit.js";
import { monitorTelegramProvider } from "../../../extensions/telegram/src/monitor.js";
import { probeTelegram } from "../../../extensions/telegram/src/probe.js";
import {
  deleteMessageTelegram,
  editMessageReplyMarkupTelegram,
  editMessageTelegram,
  pinMessageTelegram,
  renameForumTopicTelegram,
  sendMessageTelegram,
  sendPollTelegram,
  sendTypingTelegram,
  unpinMessageTelegram,
} from "../../../extensions/telegram/src/send.js";
import {
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "../../../extensions/telegram/src/thread-bindings.js";
import { resolveTelegramToken } from "../../../extensions/telegram/src/token.js";
import { telegramMessageActions } from "../../channels/plugins/actions/telegram.js";
import { createTelegramTypingLease } from "./runtime-telegram-typing.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeTelegram(): PluginRuntimeChannel["telegram"] {
  return {
    auditGroupMembership: auditTelegramGroupMembership,
    collectUnmentionedGroupIds: collectTelegramUnmentionedGroupIds,
    probeTelegram,
    resolveTelegramToken,
    sendMessageTelegram,
    sendPollTelegram,
    monitorTelegramProvider,
    messageActions: telegramMessageActions,
    threadBindings: {
      setIdleTimeoutBySessionKey: setTelegramThreadBindingIdleTimeoutBySessionKey,
      setMaxAgeBySessionKey: setTelegramThreadBindingMaxAgeBySessionKey,
    },
    typing: {
      pulse: sendTypingTelegram,
      start: async ({ to, accountId, cfg, intervalMs, messageThreadId }) =>
        await createTelegramTypingLease({
          to,
          accountId,
          cfg,
          intervalMs,
          messageThreadId,
          pulse: async ({ to, accountId, cfg, messageThreadId }) =>
            await sendTypingTelegram(to, {
              accountId,
              cfg,
              messageThreadId,
            }),
        }),
    },
    conversationActions: {
      editMessage: editMessageTelegram,
      editReplyMarkup: editMessageReplyMarkupTelegram,
      clearReplyMarkup: async (chatIdInput, messageIdInput, opts = {}) =>
        await editMessageReplyMarkupTelegram(chatIdInput, messageIdInput, [], opts),
      deleteMessage: deleteMessageTelegram,
      renameTopic: renameForumTopicTelegram,
      pinMessage: pinMessageTelegram,
      unpinMessage: unpinMessageTelegram,
    },
  };
}
