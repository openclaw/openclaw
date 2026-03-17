import { collectTelegramUnmentionedGroupIds } from "../../../extensions/telegram/src/audit.js";
import { telegramMessageActions } from "../../../extensions/telegram/src/channel-actions.js";
import {
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "../../../extensions/telegram/src/thread-bindings.js";
import { resolveTelegramToken } from "../../../extensions/telegram/src/token.js";
import { createTelegramTypingLease } from "./runtime-telegram-typing.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

type RuntimeTelegramOps = typeof import("./runtime-telegram-ops.runtime.js").runtimeTelegramOps;

let runtimeTelegramOpsPromise: Promise<RuntimeTelegramOps> | null = null;

function loadRuntimeTelegramOps() {
  runtimeTelegramOpsPromise ??= import("./runtime-telegram-ops.runtime.js").then(
    ({ runtimeTelegramOps }) => runtimeTelegramOps,
  );
  return runtimeTelegramOpsPromise;
}

const auditGroupMembershipLazy: PluginRuntimeChannel["telegram"]["auditGroupMembership"] = async (
  ...args
) => {
  const runtimeTelegramOps = await loadRuntimeTelegramOps();
  return runtimeTelegramOps.auditGroupMembership(...args);
};

const probeTelegramLazy: PluginRuntimeChannel["telegram"]["probeTelegram"] = async (...args) => {
  const runtimeTelegramOps = await loadRuntimeTelegramOps();
  return runtimeTelegramOps.probeTelegram(...args);
};

const sendMessageTelegramLazy: PluginRuntimeChannel["telegram"]["sendMessageTelegram"] = async (
  ...args
) => {
  const runtimeTelegramOps = await loadRuntimeTelegramOps();
  return runtimeTelegramOps.sendMessageTelegram(...args);
};

const sendPollTelegramLazy: PluginRuntimeChannel["telegram"]["sendPollTelegram"] = async (
  ...args
) => {
  const runtimeTelegramOps = await loadRuntimeTelegramOps();
  return runtimeTelegramOps.sendPollTelegram(...args);
};

const monitorTelegramProviderLazy: PluginRuntimeChannel["telegram"]["monitorTelegramProvider"] =
  async (...args) => {
    const runtimeTelegramOps = await loadRuntimeTelegramOps();
    return runtimeTelegramOps.monitorTelegramProvider(...args);
  };

const sendTypingTelegramLazy: PluginRuntimeChannel["telegram"]["typing"]["pulse"] = async (
  ...args
) => {
  const runtimeTelegramOps = await loadRuntimeTelegramOps();
  return runtimeTelegramOps.typing.pulse(...args);
};

const editMessageTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["editMessage"] =
  async (...args) => {
    const runtimeTelegramOps = await loadRuntimeTelegramOps();
    return runtimeTelegramOps.conversationActions.editMessage(...args);
  };

const editMessageReplyMarkupTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["editReplyMarkup"] =
  async (...args) => {
    const runtimeTelegramOps = await loadRuntimeTelegramOps();
    return runtimeTelegramOps.conversationActions.editReplyMarkup(...args);
  };

const deleteMessageTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["deleteMessage"] =
  async (...args) => {
    const runtimeTelegramOps = await loadRuntimeTelegramOps();
    return runtimeTelegramOps.conversationActions.deleteMessage(...args);
  };

const renameForumTopicTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["renameTopic"] =
  async (...args) => {
    const runtimeTelegramOps = await loadRuntimeTelegramOps();
    return runtimeTelegramOps.conversationActions.renameTopic(...args);
  };

const pinMessageTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["pinMessage"] =
  async (...args) => {
    const runtimeTelegramOps = await loadRuntimeTelegramOps();
    return runtimeTelegramOps.conversationActions.pinMessage(...args);
  };

const unpinMessageTelegramLazy: PluginRuntimeChannel["telegram"]["conversationActions"]["unpinMessage"] =
  async (...args) => {
    const runtimeTelegramOps = await loadRuntimeTelegramOps();
    return runtimeTelegramOps.conversationActions.unpinMessage(...args);
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
