// Barrel exports for the web channel pieces. Splitting the original 900+ line
// module keeps responsibilities small and testable.
export {
  DEFAULT_WEB_MEDIA_BYTES,
  HEARTBEAT_PROMPT,
  HEARTBEAT_TOKEN,
  monitorWebChannel,
  resolveHeartbeatRecipients,
  runWebHeartbeatOnce,
  type WebChannelStatus,
  type WebMonitorTuning,
} from "../extensions/whatsapp/src/auto-reply.js";
export {
  extractMediaPlaceholder,
  extractText,
  monitorWebInbox,
  type WebInboundMessage,
  type WebListenerCloseReason,
} from "../extensions/whatsapp/src/inbound.js";
export { loginWeb } from "../extensions/whatsapp/src/login.js";
export { loadWebMedia, optimizeImageToJpeg } from "../extensions/whatsapp/src/media.js";
export { sendMessageWhatsApp } from "../extensions/whatsapp/src/send.js";
export {
  createWaSocket,
  formatError,
  getStatusCode,
  logoutWeb,
  logWebSelfId,
  pickWebChannel,
  WA_WEB_AUTH_DIR,
  waitForWaConnection,
  webAuthExists,
} from "../extensions/whatsapp/src/session.js";
