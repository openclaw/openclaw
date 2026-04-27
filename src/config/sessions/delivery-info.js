import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { loadConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store.js";
export { parseSessionThreadInfo } from "./thread-info.js";
import { parseSessionThreadInfo } from "./thread-info.js";
export function extractDeliveryInfo(sessionKey) {
    const hasRoutableDeliveryContext = (context) => Boolean(context?.channel && context?.to);
    const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
    if (!sessionKey || !baseSessionKey) {
        return { deliveryContext: undefined, threadId };
    }
    let deliveryContext;
    try {
        const cfg = loadConfig();
        const storePath = resolveStorePath(cfg.session?.store);
        const store = loadSessionStore(storePath);
        let entry = store[sessionKey];
        let storedDeliveryContext = deliveryContextFromSession(entry);
        if (!hasRoutableDeliveryContext(storedDeliveryContext) && baseSessionKey !== sessionKey) {
            entry = store[baseSessionKey];
            storedDeliveryContext = deliveryContextFromSession(entry);
        }
        if (hasRoutableDeliveryContext(storedDeliveryContext)) {
            deliveryContext = {
                channel: storedDeliveryContext.channel,
                to: storedDeliveryContext.to,
                accountId: storedDeliveryContext.accountId,
                threadId: storedDeliveryContext.threadId != null
                    ? String(storedDeliveryContext.threadId)
                    : undefined,
            };
        }
    }
    catch {
        // ignore: best-effort
    }
    return { deliveryContext, threadId };
}
