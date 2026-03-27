export type { ChannelMessageActionName } from "../channels/plugins/types.js";
export type { DmPolicy, GroupPolicy, WhatsAppAccountConfig } from "../config/types.js";
export {
  createWhatsAppOutboundBase,
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppMentionStripRegexes,
} from "../channels/plugins/whatsapp-shared.js";
export {
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppAllowFromEntries,
  normalizeWhatsAppMessagingTarget,
} from "../channels/plugins/normalize/whatsapp.js";
export { resolveWhatsAppHeartbeatRecipients } from "../channels/plugins/whatsapp-heartbeat.js";
export {
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  normalizeWhatsAppTarget,
} from "../../extensions/whatsapp/api.js";
