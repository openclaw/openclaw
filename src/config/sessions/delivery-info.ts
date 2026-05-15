import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { deliveryContextFromSession, type DeliveryContext } from "../../utils/delivery-context.js";
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
  const threadId = threadIdRaw?.split(":sender:")[0]?.trim() || undefined;
  return { baseSessionKey, threadId };
}

export function resolveSessionThreadIdForRouting(
  sessionKey: string | undefined,
): string | undefined {
  const info = parseSessionThreadInfo(sessionKey);
  const isTelegramDmThreadSuffix =
    info.baseSessionKey?.includes(":telegram:dm:") && sessionKey?.includes(":thread:");
  if (isTelegramDmThreadSuffix && !sessionKey?.includes(":topic:")) {
    return undefined;
  }
  return info.threadId;
}

export function extractDeliveryInfo(sessionKey: string | undefined): {
  deliveryContext: DeliveryContext | undefined;
  threadId: string | undefined;
} {
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext: DeliveryContext | undefined;
  try {
    const cfg = loadConfig();
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    let entry = store[sessionKey];
    let storedDeliveryContext = deliveryContextFromSession(entry);
    if (!storedDeliveryContext?.to && baseSessionKey !== sessionKey) {
      entry = store[baseSessionKey];
      storedDeliveryContext = deliveryContextFromSession(entry);
    }
    if (storedDeliveryContext) {
      deliveryContext = {
        channel: storedDeliveryContext.channel,
        to: storedDeliveryContext.to,
        accountId: storedDeliveryContext.accountId,
        ...(storedDeliveryContext.threadId != null
          ? { threadId: storedDeliveryContext.threadId }
          : {}),
      };
    }
  } catch {
    // ignore: best-effort
  }
  return { deliveryContext, threadId };
}
