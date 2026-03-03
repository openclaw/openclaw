import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";
export function registerSlackMemberEvents(params) {
    const { ctx, trackEvent } = params;
    const handleMemberChannelEvent = async (params) => {
        try {
            if (ctx.shouldDropMismatchedSlackEvent(params.body)) {
                return;
            }
            trackEvent?.();
            const payload = params.event;
            const channelId = payload.channel;
            const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
            const channelType = payload.channel_type ?? channelInfo?.type;
            const ingressContext = await authorizeAndResolveSlackSystemEventContext({
                ctx,
                senderId: payload.user,
                channelId,
                channelType,
                eventKind: `member-${params.verb}`,
            });
            if (!ingressContext) {
                return;
            }
            const userInfo = payload.user ? await ctx.resolveUserName(payload.user) : {};
            const userLabel = userInfo?.name ?? payload.user ?? "someone";
            enqueueSystemEvent(`Slack: ${userLabel} ${params.verb} ${ingressContext.channelLabel}.`, {
                sessionKey: ingressContext.sessionKey,
                contextKey: `slack:member:${params.verb}:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`,
            });
        }
        catch (err) {
            ctx.runtime.error?.(danger(`slack ${params.verb} handler failed: ${String(err)}`));
        }
    };
    ctx.app.event("member_joined_channel", async ({ event, body }) => {
        await handleMemberChannelEvent({
            verb: "joined",
            event: event,
            body,
        });
    });
    ctx.app.event("member_left_channel", async ({ event, body }) => {
        await handleMemberChannelEvent({
            verb: "left",
            event: event,
            body,
        });
    });
}
