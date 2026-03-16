import { collectTelegramUnmentionedGroupIds } from "../../../extensions/telegram/src/audit.js";
import { telegramMessageActions } from "../../../extensions/telegram/src/channel-actions.js";
import {
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "../../../extensions/telegram/src/thread-bindings.js";
import { resolveTelegramToken } from "../../../extensions/telegram/src/token.js";
import { createTelegramTypingLease } from "./runtime-telegram-typing.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

let runtimeTelegramOpsPromise: Promise<typeof import("./runtime-telegram-ops.runtime.js")> | null =
  null;

function loadRuntimeTelegramOps() {
  runtimeTelegramOpsPromise ??= import("./runtime-telegram-ops.runtime.js");
  return runtimeTelegramOpsPromise;
}

const auditGroupMembershipLazy: PluginRuntimeChannel["telegram"]["auditGroupMembership"] = async (
  ...args
) => {
  const { auditTelegramGroupMembership } = await loadRuntimeTelegramOps();
  return auditTelegramGroupMembership(...args);
};

const probeTelegramLazy: PluginRuntimeChannel["telegram"]["probeTelegram"] = async (...args) => {
  const { probeTelegram } = await loadRuntimeTelegramOps();
  return probeTelegram(...args);
};

const sendMessageTelegramLazy: PluginRuntimeChannel["telegram"]["sendMessageTelegram"] = async (
  ...args
) => {
  const { sendMessageTelegram } = await loadRuntimeTelegramOps();
  return sendMessageTelegram(...args);
};

const sendPollTelegramLazy: PluginRuntimeChannel["telegram"]["sendPollTelegram"] = async (
  ...args
) => {
  const { sendPollTelegram } = await loadRuntimeTelegramOps();
  return sendPollTelegram(...args);
};

const monitorTelegramProviderLazy: PluginRuntimeChannel["telegram"]["monitorTelegramProvider"] =
  async (...args) => {
    const { monitorTelegramProvider } = await loadRuntimeTelegramOps();
    return monitorTelegramProvider(...args);
  };

const sendTypingTelegramLazy: PluginRuntimeChannel["telegram"]["typing"]["pulse"] = async (
  ...args
) => {
  const { sendTypingTelegram } = await loadRuntimeTelegramOps();
  return sendTypingTelegram(...args);
};

const editMessageTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["editMessage"] =
  async (...args) => {
    const { editMessageTelegram } = await loadRuntimeTelegramOps();
    return editMessageTelegram(...args);
  };

const editMessageReplyMarkupTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["editReplyMarkup"] =
  async (...args) => {
    const { editMessageReplyMarkupTelegram } = await loadRuntimeTelegramOps();
    return editMessageReplyMarkupTelegram(...args);
  };

const deleteMessageTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["deleteMessage"] =
  async (...args) => {
    const { deleteMessageTelegram } = await loadRuntimeTelegramOps();
    return deleteMessageTelegram(...args);
  };

const renameForumTopicTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["renameTopic"] =
  async (...args) => {
    const { renameForumTopicTelegram } = await loadRuntimeTelegramOps();
    return renameForumTopicTelegram(...args);
  };

const pinMessageTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["pinMessage"] =
  async (...args) => {
    const { pinMessageTelegram } = await loadRuntimeTelegramOps();
    return pinMessageTelegram(...args);
  };

const unpinMessageTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["unpinMessage"] =
  async (...args) => {
    const { unpinMessageTelegram } = await loadRuntimeTelegramOps();
    return unpinMessageTelegram(...args);
  };

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
