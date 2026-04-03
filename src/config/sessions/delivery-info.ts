import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";
import { loadConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store.js";

/**
 * Extract deliveryContext and threadId from a sessionKey.
 * Supports generic :thread: suffixes plus plugin-owned thread/session grammars.
 */
export function parseSessionThreadInfo(sessionKey: string | undefined): {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
} {
  return resolveSessionThreadInfo(sessionKey);
}

export function extractDeliveryInfo(sessionKey: string | undefined): {
  deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string }
    | undefined;
  threadId: string | undefined;
} {
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string }
    | undefined;
  try {
    const cfg = loadConfig();
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);
    let entry = store[sessionKey];
    if (!entry?.deliveryContext && baseSessionKey !== sessionKey) {
      entry = store[baseSessionKey];
    }
    if (entry?.deliveryContext) {
      const resolvedThreadId =
        entry.deliveryContext.threadId ?? entry.lastThreadId ?? entry.origin?.threadId;
      deliveryContext = {
        channel: entry.deliveryContext.channel,
        to: entry.deliveryContext.to,
        accountId: entry.deliveryContext.accountId,
        threadId: resolvedThreadId != null ? String(resolvedThreadId) : undefined,
      };
    }
  } catch {
    // ignore: best-effort
  }
  return { deliveryContext, threadId };
}
