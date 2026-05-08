import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { getSessionEntry } from "./store.js";
export { parseSessionThreadInfo } from "./thread-info.js";
import { parseSessionThreadInfo } from "./thread-info.js";

export function extractDeliveryInfo(sessionKey: string | undefined): {
  deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string }
    | undefined;
  threadId: string | undefined;
} {
  const hasRoutableDeliveryContext = (context?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  }): context is {
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string | number;
  } => Boolean(context?.channel && context?.to);
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string }
    | undefined;
  try {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    let entry = getSessionEntry({ agentId, sessionKey });
    let storedDeliveryContext = deliveryContextFromSession(entry);
    if (!hasRoutableDeliveryContext(storedDeliveryContext) && baseSessionKey !== sessionKey) {
      entry = getSessionEntry({ agentId, sessionKey: baseSessionKey });
      storedDeliveryContext = deliveryContextFromSession(entry);
    }
    if (hasRoutableDeliveryContext(storedDeliveryContext)) {
      deliveryContext = {
        channel: storedDeliveryContext.channel,
        to: storedDeliveryContext.to,
        accountId: storedDeliveryContext.accountId,
        threadId:
          storedDeliveryContext.threadId != null
            ? String(storedDeliveryContext.threadId)
            : undefined,
      };
    }
  } catch {
    // ignore: best-effort
  }
  return { deliveryContext, threadId };
}
