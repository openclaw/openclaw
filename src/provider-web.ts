// Barrel exports for the web provider pieces. Splitting the original 900+ line
// module keeps responsibilities small and testable without changing the public API.
export {
  DEFAULT_WEB_MEDIA_BYTES,
  HEARTBEAT_PROMPT,
  HEARTBEAT_TOKEN,
  monitorWebProvider,
  runWebHeartbeatOnce,
  type WebMonitorTuning,
} from "./web/auto-reply.js";
export {
  extractMediaPlaceholder,
  extractText,
  monitorWebInbox,
  type WebInboundMessage,
  type WebListenerCloseReason,
} from "./web/inbound.js";
export { loginWeb } from "./web/login.js";
export { loadWebMedia, optimizeImageToJpeg } from "./web/media.js";
export { sendMessageWeb } from "./web/outbound.js";
export {
  createWaSocket,
  formatError,
  getStatusCode,
  logoutWeb,
  logWebSelfId,
  pickProvider,
  WA_WEB_AUTH_DIR,
  waitForWaConnection,
  webAuthExists,
} from "./web/session.js";
