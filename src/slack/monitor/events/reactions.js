import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";
export function registerSlackReactionEvents(params) {
    const { ctx, trackEvent } = params;
    const handleReactionEvent = async (event, action) => {
        try {
            const item = event.item;
            if (!item || item.type !== "message") {
                return;
            }
            trackEvent?.();
            const ingressContext = await authorizeAndResolveSlackSystemEventContext({
                ctx,
                senderId: event.user,
                channelId: item.channel,
                eventKind: "reaction",
            });
            if (!ingressContext) {
                return;
            }
            const actorInfoPromise = event.user
                ? ctx.resolveUserName(event.user)
                : Promise.resolve(undefined);
            const authorInfoPromise = event.item_user
                ? ctx.resolveUserName(event.item_user)
                : Promise.resolve(undefined);
            const [actorInfo, authorInfo] = await Promise.all([actorInfoPromise, authorInfoPromise]);
            const actorLabel = actorInfo?.name ?? event.user;
            const emojiLabel = event.reaction ?? "emoji";
            const authorLabel = authorInfo?.name ?? event.item_user;
            const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${ingressContext.channelLabel} msg ${item.ts}`;
            const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
            enqueueSystemEvent(text, {
                sessionKey: ingressContext.sessionKey,
                contextKey: `slack:reaction:${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}`,
            });
        }
        catch (err) {
            ctx.runtime.error?.(danger(`slack reaction handler failed: ${String(err)}`));
        }
    };
    ctx.app.event("reaction_added", async ({ event, body }) => {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
            return;
        }
        await handleReactionEvent(event, "added");
    });
    ctx.app.event("reaction_removed", async ({ event, body }) => {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
            return;
        }
        await handleReactionEvent(event, "removed");
    });
}
