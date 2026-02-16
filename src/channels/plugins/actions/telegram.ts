import type { TelegramActionConfig } from "../../../config/types.telegram.js";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "../types.js";
import {
  createActionGate,
  readNumberParam,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
} from "../../../agents/tools/common.js";
import { handleTelegramAction } from "../../../agents/tools/telegram-actions.js";
import { extractToolSend } from "../../../plugin-sdk/tool-send.js";
import { listEnabledTelegramAccounts } from "../../../telegram/accounts.js";
import { isTelegramInlineButtonsEnabled } from "../../../telegram/inline-buttons.js";

const providerId = "telegram";

function readTelegramSendParams(params: Record<string, unknown>) {
  const to = readStringParam(params, "to", { required: true });
  const mediaUrl = readStringParam(params, "media", { trim: false });
  const message = readStringParam(params, "message", { required: !mediaUrl, allowEmpty: true });
  const caption = readStringParam(params, "caption", { allowEmpty: true });
  const content = message || caption || "";
  const replyTo = readStringParam(params, "replyTo");
  const threadId = readStringParam(params, "threadId");
  const buttons = params.buttons;
  const asVoice = typeof params.asVoice === "boolean" ? params.asVoice : undefined;
  const silent = typeof params.silent === "boolean" ? params.silent : undefined;
  const quoteText = readStringParam(params, "quoteText");
  return {
    to,
    content,
    mediaUrl: mediaUrl ?? undefined,
    replyToMessageId: replyTo ?? undefined,
    messageThreadId: threadId ?? undefined,
    buttons,
    asVoice,
    silent,
    quoteText: quoteText ?? undefined,
  };
}

export const telegramMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledTelegramAccounts(cfg).filter(
      (account) => account.tokenSource !== "none",
    );
    if (accounts.length === 0) {
      return [];
    }
    // Union of all accounts' action gates (any account enabling an action makes it available)
    const gates = accounts.map((a) => createActionGate(a.config.actions));
    const gate = (key: keyof TelegramActionConfig, defaultValue = true) =>
      gates.some((g) => g(key, defaultValue));
    const actions = new Set<ChannelMessageActionName>(["send"]);
    if (gate("reactions")) {
      actions.add("react");
    }
    if (gate("deleteMessage")) {
      actions.add("delete");
    }
    if (gate("editMessage")) {
      actions.add("edit");
    }
    if (gate("sticker", false)) {
      actions.add("sticker");
      actions.add("sticker-search");
    }
    return Array.from(actions);
  },
  supportsButtons: ({ cfg }) => {
    const accounts = listEnabledTelegramAccounts(cfg).filter(
      (account) => account.tokenSource !== "none",
    );
    if (accounts.length === 0) {
      return false;
    }
    return accounts.some((account) =>
      isTelegramInlineButtonsEnabled({ cfg, accountId: account.accountId }),
    );
  },
  extractToolSend: ({ args }) => {
    return extractToolSend(args, "sendMessage");
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      const sendParams = readTelegramSendParams(params);
      return await handleTelegramAction(
        {
          action: "sendMessage",
          ...sendParams,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    if (action === "react") {
      const messageId = readStringOrNumberParam(params, "messageId", {
        required: true,
      });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;
      return await handleTelegramAction(
        {
          action: "react",
          chatId:
            readStringOrNumberParam(params, "chatId") ??
            readStringOrNumberParam(params, "channelId") ??
            readStringParam(params, "to", { required: true }),
          messageId,
          emoji,
          remove,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    if (action === "delete") {
      const chatId =
        readStringOrNumberParam(params, "chatId") ??
        readStringOrNumberParam(params, "channelId") ??
        readStringParam(params, "to", { required: true });
      const messageId = readNumberParam(params, "messageId", {
        required: true,
        integer: true,
      });
      return await handleTelegramAction(
        {
          action: "deleteMessage",
          chatId,
          messageId,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    if (action === "edit") {
      const chatId =
        readStringOrNumberParam(params, "chatId") ??
        readStringOrNumberParam(params, "channelId") ??
        readStringParam(params, "to", { required: true });
      const messageId = readNumberParam(params, "messageId", {
        required: true,
        integer: true,
      });
      const message = readStringParam(params, "message", { required: true, allowEmpty: false });
      const buttons = params.buttons;
      return await handleTelegramAction(
        {
          action: "editMessage",
          chatId,
          messageId,
          content: message,
          buttons,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    if (action === "sticker") {
      const to =
        readStringParam(params, "to") ?? readStringParam(params, "target", { required: true });
      // Accept stickerId (array from shared schema) and use first element as fileId
      const stickerIds = readStringArrayParam(params, "stickerId");
      const fileId = stickerIds?.[0] ?? readStringParam(params, "fileId", { required: true });
      const replyToMessageId = readNumberParam(params, "replyTo", { integer: true });
      const messageThreadId = readNumberParam(params, "threadId", { integer: true });
      return await handleTelegramAction(
        {
          action: "sendSticker",
          to,
          fileId,
          replyToMessageId: replyToMessageId ?? undefined,
          messageThreadId: messageThreadId ?? undefined,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    if (action === "sticker-search") {
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      return await handleTelegramAction(
        {
          action: "searchSticker",
          query,
          limit: limit ?? undefined,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
