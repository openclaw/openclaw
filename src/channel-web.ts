// Barrel exports for the web channel pieces. Splitting the original 900+ line
// module keeps responsibilities small and testable.
export {
  DEFAULT_WEB_MEDIA_BYTES,
  HEARTBEAT_PROMPT,
  HEARTBEAT_TOKEN,
  monitorWebChannel,
  resolveHeartbeatRecipients,
  runWebHeartbeatOnce,
} from "./plugin-sdk/whatsapp.js";
export { extractMediaPlaceholder, extractText, monitorWebInbox } from "./plugin-sdk/whatsapp.js";
export { loginWeb } from "./plugin-sdk/whatsapp.js";
export { loadWebMedia, optimizeImageToJpeg } from "./media/web-media.js";
export { sendMessageWhatsApp } from "./plugin-sdk/whatsapp.js";
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
} from "./plugin-sdk/whatsapp.js";
