// Legacy compatibility shim for older channel helpers. Prefer the dedicated
// plugin-sdk subpaths instead of adding new imports here.

export * from "../channels/chat-type.js";
export * from "../channels/reply-prefix.js";
export * from "../channels/typing.js";
export type * from "../channels/plugins/types.js";
export { normalizeChannelId } from "../channels/plugins/registry.js";
export * from "../channels/plugins/normalize/signal.js";
export * from "../channels/plugins/normalize/whatsapp.js";
export * from "../channels/plugins/outbound/interactive.js";
export * from "../channels/plugins/whatsapp-heartbeat.js";
export * from "../polls.js";
export { enqueueSystemEvent } from "../infra/system-events.js";
export { recordChannelActivity } from "../infra/channel-activity.js";
export * from "../infra/heartbeat-events.ts";
export * from "../infra/heartbeat-visibility.ts";
export {
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  normalizeWhatsAppTarget,
} from "./whatsapp-targets.js";
export {
  createAccountStatusSink,
  keepHttpServerTaskAlive,
  waitUntilAbort,
} from "./channel-lifecycle.js";
