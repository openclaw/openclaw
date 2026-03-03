import { resolveStorePath, updateLastRoute } from "../../../config/sessions.js";
import { formatError } from "../../session.js";
export function trackBackgroundTask(backgroundTasks, task) {
    backgroundTasks.add(task);
    void task.finally(() => {
        backgroundTasks.delete(task);
    });
}
export function updateLastRouteInBackground(params) {
    const storePath = resolveStorePath(params.cfg.session?.store, {
        agentId: params.storeAgentId,
    });
    const task = updateLastRoute({
        storePath,
        sessionKey: params.sessionKey,
        deliveryContext: {
            channel: params.channel,
            to: params.to,
            accountId: params.accountId,
        },
        ctx: params.ctx,
    }).catch((err) => {
        params.warn({
            error: formatError(err),
            storePath,
            sessionKey: params.sessionKey,
            to: params.to,
        }, "failed updating last route");
    });
    trackBackgroundTask(params.backgroundTasks, task);
}
export function awaitBackgroundTasks(backgroundTasks) {
    if (backgroundTasks.size === 0) {
        return Promise.resolve();
    }
    return Promise.allSettled(backgroundTasks).then(() => {
        backgroundTasks.clear();
    });
}
