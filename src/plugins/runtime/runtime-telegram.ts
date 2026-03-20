import {
  collectTelegramUnmentionedGroupIds,
  resolveTelegramToken,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
  telegramMessageActions,
} from "../../../extensions/telegram/runtime-api.js";
import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeSurface,
} from "../../shared/lazy-runtime.js";
import { createTelegramTypingLease } from "./runtime-telegram-typing.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

const loadRuntimeTelegramOps = createLazyRuntimeSurface(
  () => import("./runtime-telegram-ops.runtime.js"),
  ({ runtimeTelegramOps }) => runtimeTelegramOps,
);

const bindTelegramRuntimeMethod = createLazyRuntimeMethodBinder(loadRuntimeTelegramOps);

const auditGroupMembershipLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.auditGroupMembership,
);
const probeTelegramLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.probeTelegram,
);
const sendMessageTelegramLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.sendMessageTelegram,
);
const sendPollTelegramLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.sendPollTelegram,
);
const monitorTelegramProviderLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.monitorTelegramProvider,
);
const sendTypingTelegramLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.typing.pulse,
);
const editMessageTelegramLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.conversationActions.editMessage,
);
const editMessageReplyMarkupTelegramLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.conversationActions.editReplyMarkup,
);
const deleteMessageTelegramLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.conversationActions.deleteMessage,
);
const renameForumTopicTelegramLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.conversationActions.renameTopic,
);
const pinMessageTelegramLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.conversationActions.pinMessage,
);
const unpinMessageTelegramLazy = bindTelegramRuntimeMethod(
  (runtimeTelegramOps) => runtimeTelegramOps.conversationActions.unpinMessage,
);

export function createRuntimeTelegram(): PluginRuntimeChannel["telegram"] {
  return {
    auditGroupMembership: auditGroupMembershipLazy,
    collectUnmentionedGroupIds: collectTelegramUnmentionedGroupIds,
    probeTelegram: probeTelegramLazy,
    resolveTelegramToken,
    sendMessageTelegram: sendMessageTelegramLazy,
    sendPollTelegram: sendPollTelegramLazy,
    monitorTelegramProvider: monitorTelegramProviderLazy,
    messageActions: telegramMessageActions,
    threadBindings: {
      setIdleTimeoutBySessionKey: setTelegramThreadBindingIdleTimeoutBySessionKey,
      setMaxAgeBySessionKey: setTelegramThreadBindingMaxAgeBySessionKey,
    },
    typing: {
      pulse: sendTypingTelegramLazy,
      start: async ({ to, accountId, cfg, intervalMs, messageThreadId }) =>
        await createTelegramTypingLease({
          to,
          accountId,
          cfg,
          intervalMs,
          messageThreadId,
          pulse: async ({ to, accountId, cfg, messageThreadId }) =>
            await sendTypingTelegramLazy(to, {
              accountId,
              cfg,
              messageThreadId,
            }),
        }),
    },
    conversationActions: {
      editMessage: editMessageTelegramLazy,
      editReplyMarkup: editMessageReplyMarkupTelegramLazy,
      clearReplyMarkup: async (chatIdInput, messageIdInput, opts = {}) =>
        await editMessageReplyMarkupTelegramLazy(chatIdInput, messageIdInput, [], opts),
      deleteMessage: deleteMessageTelegramLazy,
      renameTopic: renameForumTopicTelegramLazy,
      pinMessage: pinMessageTelegramLazy,
      unpinMessage: unpinMessageTelegramLazy,
    },
  };
}
