/**
 * @deprecated Compatibility shim only. Keep old plugins working, but do not
 * add new imports here and do not use this subpath from repo code.
 * Prefer the dedicated generic plugin-sdk subpaths instead.
 */

import { enqueueSystemEvent as enqueueSystemEventInternal } from "../infra/system-events.js";

export * from "../channels/chat-type.js";
export * from "../channels/reply-prefix.js";
export * from "../channels/typing.js";
export type * from "../channels/plugins/types.public.js";
export { normalizeChannelId } from "../channels/plugins/registry.js";
export * from "../channels/plugins/outbound/interactive.js";
export * from "../polls.js";
export { resetSystemEventsForTest } from "../infra/system-events.js";

/**
 * Channel-originated system events are untrusted by construction: a channel
 * plugin must never set `trusted: true` to bypass the inbound anti-spoof
 * sanitizer. Force the producer side untrusted regardless of what the plugin
 * passes. Trusted-internal producers use the direct `infra/system-events`
 * import, not this SDK boundary.
 *
 * Also strip the session-delivery ack fields: those drive a blind
 * `deleteDeliveryQueueEntry` at a caller-supplied `sessionDeliveryAckStateDir`
 * on drain, so a plugin must never inject them via this boundary. Legitimate
 * ack producers (the continuation-return path) set them through the direct
 * `infra/system-events` import, not this SDK re-export.
 */
export function enqueueSystemEvent(
  text: string,
  options: Parameters<typeof enqueueSystemEventInternal>[1],
): boolean {
  const {
    sessionDeliveryAckId: _ackId,
    sessionDeliveryAckStateDir: _ackStateDir,
    ...rest
  } = options ?? {};
  return enqueueSystemEventInternal(text, { ...rest, trusted: false });
}
export { recordChannelActivity } from "../infra/channel-activity.js";
export * from "../infra/heartbeat-events.ts";
export * from "../infra/heartbeat-visibility.ts";
export * from "../infra/transport-ready.js";
export {
  createAccountStatusSink,
  keepHttpServerTaskAlive,
  waitUntilAbort,
} from "./channel-lifecycle.core.js";
