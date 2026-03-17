import {
  auditTelegramGroupMembership as auditTelegramGroupMembershipImpl,
  collectTelegramUnmentionedGroupIds as collectTelegramUnmentionedGroupIdsImpl,
} from "../../../extensions/telegram/src/audit.js";
import { monitorTelegramProvider as monitorTelegramProviderImpl } from "../../../extensions/telegram/src/monitor.js";
import { probeTelegram as probeTelegramImpl } from "../../../extensions/telegram/src/probe.js";
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
} from "../../../extensions/telegram/src/send.js";
import { resolveTelegramToken as resolveTelegramTokenImpl } from "../../../extensions/telegram/src/token.js";

type AuditTelegramGroupMembership =
  typeof import("../../../extensions/telegram/src/audit.js").auditTelegramGroupMembership;
type CollectTelegramUnmentionedGroupIds =
  typeof import("../../../extensions/telegram/src/audit.js").collectTelegramUnmentionedGroupIds;
type MonitorTelegramProvider =
  typeof import("../../../extensions/telegram/src/monitor.js").monitorTelegramProvider;
type ProbeTelegram = typeof import("../../../extensions/telegram/src/probe.js").probeTelegram;
type DeleteMessageTelegram =
  typeof import("../../../extensions/telegram/src/send.js").deleteMessageTelegram;
type EditMessageReplyMarkupTelegram =
  typeof import("../../../extensions/telegram/src/send.js").editMessageReplyMarkupTelegram;
type EditMessageTelegram =
  typeof import("../../../extensions/telegram/src/send.js").editMessageTelegram;
type PinMessageTelegram =
  typeof import("../../../extensions/telegram/src/send.js").pinMessageTelegram;
type RenameForumTopicTelegram =
  typeof import("../../../extensions/telegram/src/send.js").renameForumTopicTelegram;
type SendMessageTelegram =
  typeof import("../../../extensions/telegram/src/send.js").sendMessageTelegram;
type SendPollTelegram = typeof import("../../../extensions/telegram/src/send.js").sendPollTelegram;
type SendTypingTelegram =
  typeof import("../../../extensions/telegram/src/send.js").sendTypingTelegram;
type UnpinMessageTelegram =
  typeof import("../../../extensions/telegram/src/send.js").unpinMessageTelegram;
type ResolveTelegramToken =
  typeof import("../../../extensions/telegram/src/token.js").resolveTelegramToken;

export function auditTelegramGroupMembership(
  ...args: Parameters<AuditTelegramGroupMembership>
): ReturnType<AuditTelegramGroupMembership> {
  return auditTelegramGroupMembershipImpl(...args);
}

export function collectTelegramUnmentionedGroupIds(
  ...args: Parameters<CollectTelegramUnmentionedGroupIds>
): ReturnType<CollectTelegramUnmentionedGroupIds> {
  return collectTelegramUnmentionedGroupIdsImpl(...args);
}

export function monitorTelegramProvider(
  ...args: Parameters<MonitorTelegramProvider>
): ReturnType<MonitorTelegramProvider> {
  return monitorTelegramProviderImpl(...args);
}

export function probeTelegram(...args: Parameters<ProbeTelegram>): ReturnType<ProbeTelegram> {
  return probeTelegramImpl(...args);
}

export function deleteMessageTelegram(
  ...args: Parameters<DeleteMessageTelegram>
): ReturnType<DeleteMessageTelegram> {
  return deleteMessageTelegramImpl(...args);
}

export function editMessageReplyMarkupTelegram(
  ...args: Parameters<EditMessageReplyMarkupTelegram>
): ReturnType<EditMessageReplyMarkupTelegram> {
  return editMessageReplyMarkupTelegramImpl(...args);
}

export function editMessageTelegram(
  ...args: Parameters<EditMessageTelegram>
): ReturnType<EditMessageTelegram> {
  return editMessageTelegramImpl(...args);
}

export function pinMessageTelegram(
  ...args: Parameters<PinMessageTelegram>
): ReturnType<PinMessageTelegram> {
  return pinMessageTelegramImpl(...args);
}

export function renameForumTopicTelegram(
  ...args: Parameters<RenameForumTopicTelegram>
): ReturnType<RenameForumTopicTelegram> {
  return renameForumTopicTelegramImpl(...args);
}

export function sendMessageTelegram(
  ...args: Parameters<SendMessageTelegram>
): ReturnType<SendMessageTelegram> {
  return sendMessageTelegramImpl(...args);
}

export function sendPollTelegram(
  ...args: Parameters<SendPollTelegram>
): ReturnType<SendPollTelegram> {
  return sendPollTelegramImpl(...args);
}

export function sendTypingTelegram(
  ...args: Parameters<SendTypingTelegram>
): ReturnType<SendTypingTelegram> {
  return sendTypingTelegramImpl(...args);
}

export function unpinMessageTelegram(
  ...args: Parameters<UnpinMessageTelegram>
): ReturnType<UnpinMessageTelegram> {
  return unpinMessageTelegramImpl(...args);
}

export function resolveTelegramToken(
  ...args: Parameters<ResolveTelegramToken>
): ReturnType<ResolveTelegramToken> {
  return resolveTelegramTokenImpl(...args);
}
