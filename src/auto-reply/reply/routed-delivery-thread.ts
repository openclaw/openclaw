/** Resolves the thread id used when replies are routed through channel delivery helpers. */
import { parseSessionThreadInfoFast } from "../../config/sessions/thread-info.js";
import type { MsgContext } from "../templating.js";

/**
 * Resolves the best thread id for routed delivery, using these fallbacks in order:
 * 1. Inbound message thread id (ctx.MessageThreadId)
 * 2. Transport-level thread id (ctx.TransportThreadId)
 * 3. Explicit delivery thread id from the session delivery context
 * 4. Thread id parsed from the session key suffix
 *
 * ACP sessions store their thread id in deliveryContext (set during spawn), but
 * their session keys use an `agent:<id>:acp:<uuid>` format without a `:thread:`
 * suffix, so the session-key parse never finds it.  Passing `deliveryThreadId`
 * from the session entry's `deliveryContext.threadId` fills that gap.
 */
export function resolveRoutedDeliveryThreadId(params: {
  ctx: MsgContext;
  sessionKey?: string;
  deliveryThreadId?: string | number;
}): string | number | undefined {
  if (params.ctx.MessageThreadId != null) {
    return params.ctx.MessageThreadId;
  }
  if (params.ctx.TransportThreadId != null) {
    return params.ctx.TransportThreadId;
  }
  if (params.deliveryThreadId != null) {
    return params.deliveryThreadId;
  }
  return parseSessionThreadInfoFast(params.sessionKey).threadId;
}
