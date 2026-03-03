import { logVerbose } from "../../../globals.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
export async function authorizeAndResolveSlackSystemEventContext(params) {
    const { ctx, senderId, channelId, channelType, eventKind } = params;
    const auth = await authorizeSlackSystemEventSender({
        ctx,
        senderId,
        channelId,
        channelType,
    });
    if (!auth.allowed) {
        logVerbose(`slack: drop ${eventKind} sender ${senderId ?? "unknown"} channel=${channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`);
        return undefined;
    }
    const channelLabel = resolveSlackChannelLabel({
        channelId,
        channelName: auth.channelName,
    });
    const sessionKey = ctx.resolveSlackSystemEventSessionKey({
        channelId,
        channelType: auth.channelType,
    });
    return {
        channelLabel,
        sessionKey,
    };
}
