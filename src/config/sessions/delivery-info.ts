import { deliveryContextFromSession } from "../../utils/delivery-context.js";
import { loadConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store.js";
export { parseSessionThreadInfo } from "./thread-info.js";
import { parseSessionThreadInfo } from "./thread-info.js";

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
    if (!deliveryContextFromSession(entry) && baseSessionKey !== sessionKey) {
      entry = store[baseSessionKey];
    }
    const storedDeliveryContext = deliveryContextFromSession(entry);
    if (storedDeliveryContext) {
      const resolvedThreadId =
        storedDeliveryContext.threadId ?? entry?.lastThreadId ?? entry?.origin?.threadId;
      deliveryContext = {
        channel: storedDeliveryContext.channel,
        to: storedDeliveryContext.to,
        accountId: storedDeliveryContext.accountId,
        threadId: resolvedThreadId != null ? String(resolvedThreadId) : undefined,
      };
    }
  } catch {
    // ignore: best-effort
  }
  return { deliveryContext, threadId };
}
