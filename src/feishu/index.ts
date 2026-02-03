// Feishu channel public exports

export { createFeishuBot, buildFeishuSessionKey, buildFeishuPeerId } from "./bot.js";
export { createFeishuClient, type FeishuClient } from "./client.js";
export {
  monitorFeishuProvider,
  createFeishuWebhookHandler,
  registerMessageProcessing,
  unregisterMessageProcessing,
  updateMessageProcessingStatus,
  abortMessageProcessing,
} from "./monitor.js";
export {
  sendMessageFeishu,
  sendImageFeishu,
  reactMessageFeishu,
  deleteMessageFeishu,
  editMessageFeishu,
  markdownToFeishuText,
  markdownToFeishuPost,
  buildFeishuMarkdownCard,
  hasMarkdown,
  hasRichMarkdown,
  resolveUseInteractiveCard,
  type FeishuInteractiveCard,
} from "./send.js";
export {
  getStartupChatIds,
  resolveFeishuAccount,
  listFeishuAccountIds,
  listEnabledFeishuAccounts,
} from "./accounts.js";
export { resolveFeishuCredentials } from "./token.js";
export type {
  FeishuMessageContext,
  MonitorFeishuOpts,
  FeishuMessageRecallContext,
} from "./monitor.js";
export type { FeishuBotOptions } from "./bot.js";
export type { FeishuMessageRecalledEvent } from "./events.js";

// @mention support
export {
  extractMentionTargets,
  isMentionForwardRequest,
  extractMessageBody,
  formatMentionForText,
  formatMentionAllForText,
  formatMentionForCard,
  formatMentionAllForCard,
  buildMentionedMessage,
  buildMentionedCardContent,
  type MentionTarget,
  type FeishuMention,
} from "./mention.js";

// Feishu tools (document, wiki, drive, permission)
export {
  createFeishuTools,
  createFeishuDocTool,
  createFeishuWikiTool,
  createFeishuDriveTool,
  createFeishuPermTool,
} from "./tools/index.js";

// Cross-channel X commands
export { handleXCommand, type XCommandResult } from "./x-commands.js";
