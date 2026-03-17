import { collectTelegramUnmentionedGroupIds } from "../../../extensions/telegram/src/audit.js";
import { telegramMessageActions } from "../../../extensions/telegram/src/channel-actions.js";
import {
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "../../../extensions/telegram/src/thread-bindings.js";
import { resolveTelegramToken } from "../../../extensions/telegram/src/token.js";
import { createLazyRuntimeMethod, createLazyRuntimeSurface } from "../../shared/lazy-runtime.js";
import { createTelegramTypingLease } from "./runtime-telegram-typing.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

type RuntimeTelegramOps = typeof import("./runtime-telegram-ops.runtime.js").runtimeTelegramOps;

const loadRuntimeTelegramOps = createLazyRuntimeSurface(
  () => import("./runtime-telegram-ops.runtime.js"),
  ({ runtimeTelegramOps }) => runtimeTelegramOps,
);

const auditGroupMembershipLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["auditGroupMembership"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["auditGroupMembership"]>
>(loadRuntimeTelegramOps, (runtimeTelegramOps) => runtimeTelegramOps.auditGroupMembership);

const probeTelegramLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["probeTelegram"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["probeTelegram"]>
>(loadRuntimeTelegramOps, (runtimeTelegramOps) => runtimeTelegramOps.probeTelegram);

const sendMessageTelegramLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["sendMessageTelegram"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["sendMessageTelegram"]>
>(loadRuntimeTelegramOps, (runtimeTelegramOps) => runtimeTelegramOps.sendMessageTelegram);

const sendPollTelegramLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["sendPollTelegram"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["sendPollTelegram"]>
>(loadRuntimeTelegramOps, (runtimeTelegramOps) => runtimeTelegramOps.sendPollTelegram);

const monitorTelegramProviderLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["monitorTelegramProvider"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["monitorTelegramProvider"]>
>(loadRuntimeTelegramOps, (runtimeTelegramOps) => runtimeTelegramOps.monitorTelegramProvider);

const sendTypingTelegramLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["typing"]["pulse"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["typing"]["pulse"]>
>(loadRuntimeTelegramOps, (runtimeTelegramOps) => runtimeTelegramOps.typing.pulse);

const editMessageTelegramLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["conversationActions"]["editMessage"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["conversationActions"]["editMessage"]>
>(
  loadRuntimeTelegramOps,
  (runtimeTelegramOps) => runtimeTelegramOps.conversationActions.editMessage,
);

const editMessageReplyMarkupTelegramLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["conversationActions"]["editReplyMarkup"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["conversationActions"]["editReplyMarkup"]>
>(
  loadRuntimeTelegramOps,
  (runtimeTelegramOps) => runtimeTelegramOps.conversationActions.editReplyMarkup,
);

const deleteMessageTelegramLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["conversationActions"]["deleteMessage"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["conversationActions"]["deleteMessage"]>
>(
  loadRuntimeTelegramOps,
  (runtimeTelegramOps) => runtimeTelegramOps.conversationActions.deleteMessage,
);

const renameForumTopicTelegramLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["conversationActions"]["renameTopic"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["conversationActions"]["renameTopic"]>
>(
  loadRuntimeTelegramOps,
  (runtimeTelegramOps) => runtimeTelegramOps.conversationActions.renameTopic,
);

const pinMessageTelegramLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["conversationActions"]["pinMessage"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["conversationActions"]["pinMessage"]>
>(
  loadRuntimeTelegramOps,
  (runtimeTelegramOps) => runtimeTelegramOps.conversationActions.pinMessage,
);

const unpinMessageTelegramLazy = createLazyRuntimeMethod<
  RuntimeTelegramOps,
  Parameters<PluginRuntimeChannel["telegram"]["conversationActions"]["unpinMessage"]>,
  ReturnType<PluginRuntimeChannel["telegram"]["conversationActions"]["unpinMessage"]>
>(
  loadRuntimeTelegramOps,
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
