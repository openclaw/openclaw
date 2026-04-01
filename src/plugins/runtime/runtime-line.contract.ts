import {
  buildTemplateMessageFromPayload,
  createQuickReplyItems,
  monitorLineProvider,
  probeLineBot,
  pushFlexMessage,
  pushLocationMessage,
  pushMessageLine,
  pushMessagesLine,
  pushTemplateMessage,
  pushTextMessageWithQuickReplies,
  sendMessageLine,
} from "../../plugin-sdk/line-runtime.js";
import {
  listLineAccountIds,
  normalizeAccountId,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../plugin-sdk/line.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export const runtimeLine = {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
  normalizeAccountId,
  probeLineBot,
  sendMessageLine,
  pushMessageLine,
  pushMessagesLine,
  pushFlexMessage,
  pushTemplateMessage,
  pushLocationMessage,
  pushTextMessageWithQuickReplies,
  createQuickReplyItems,
  buildTemplateMessageFromPayload,
  monitorLineProvider,
} satisfies PluginRuntimeChannel["line"];
