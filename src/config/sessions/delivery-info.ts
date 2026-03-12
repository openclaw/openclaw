import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { loadConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store.js";

/**
 * Extract deliveryContext and threadId from a sessionKey.
 * Supports both :thread: (most channels) and :topic: (Telegram).
 */
export function parseSessionThreadInfo(sessionKey: string | undefined): {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
} {
  if (!sessionKey) {
    return { baseSessionKey: undefined, threadId: undefined };
  }
  const topicIndex = sessionKey.lastIndexOf(":topic:");
  const threadIndex = sessionKey.lastIndexOf(":thread:");
  const markerIndex = Math.max(topicIndex, threadIndex);
  const marker = topicIndex > threadIndex ? ":topic:" : ":thread:";

  const baseSessionKey = markerIndex === -1 ? sessionKey : sessionKey.slice(0, markerIndex);
  const threadIdRaw =
    markerIndex === -1 ? undefined : sessionKey.slice(markerIndex + marker.length);
  const threadId = threadIdRaw?.trim() || undefined;
  return { baseSessionKey, threadId };
}

export function extractDeliveryInfo(sessionKey: string | undefined): {
  deliveryContext: { channel?: string; to?: string; accountId?: string } | undefined;
  threadId: string | undefined;
} {
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext: { channel?: string; to?: string; accountId?: string } | undefined;
  let resolvedThreadId = threadId;
  try {
    const cfg = loadConfig();
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);
    const entries = [store[sessionKey]];
    if (baseSessionKey !== sessionKey) {
      entries.push(store[baseSessionKey]);
    }
    for (const entry of entries) {
      if (!deliveryContext && entry?.deliveryContext) {
        deliveryContext = {
          channel: entry.deliveryContext.channel,
          to: entry.deliveryContext.to,
          accountId: entry.deliveryContext.accountId,
        };
      }
      if (resolvedThreadId == null) {
        const normalizedThreadId = normalizeDeliveryContext({
          threadId:
            entry?.lastThreadId ?? entry?.deliveryContext?.threadId ?? entry?.origin?.threadId,
        })?.threadId;
        if (normalizedThreadId != null && normalizedThreadId !== "") {
          resolvedThreadId = String(normalizedThreadId);
        }
      }
      if (deliveryContext && resolvedThreadId != null) {
        break;
      }
    }
  } catch {
    // ignore: best-effort
  }
  return { deliveryContext, threadId: resolvedThreadId };
}
