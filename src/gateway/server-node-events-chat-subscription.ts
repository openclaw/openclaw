// Handles `chat.subscribe` / `chat.unsubscribe` node events: a paired node
// opts its connection in or out of a session's fanout.
//
// Fanout is keyed by the canonical session, so the connection owner is carried
// through subscribe/unsubscribe to keep reconnect safe.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import { parseNodeEventPayload } from "./server-node-event-source.js";
import type {
  NodeEvent,
  NodeEventContext,
  NodeEventHandlerOptions,
  NodeEventHandleResult,
} from "./server-node-events-types.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

export async function handleNodeChatSubscriptionEvent(
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  opts?: NodeEventHandlerOptions,
): Promise<NodeEventHandleResult | undefined> {
  const sessionKey = normalizeOptionalString(parseNodeEventPayload(evt.payloadJSON)?.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const { canonicalKey } = resolveSessionStoreIdentity({ cfg: getRuntimeConfig(), sessionKey });
  if (evt.event === "chat.subscribe") {
    await ctx.nodeSubscribe(nodeId, canonicalKey, opts?.connId);
  } else {
    await ctx.nodeUnsubscribe(nodeId, canonicalKey, opts?.connId);
  }
  return undefined;
}
