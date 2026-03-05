import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { inferSlackChannelType } from "../context.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackReactionEvent } from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

export function registerSlackReactionEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  trackChannelEvent?: (isChannel: boolean) => void;
}) {
  const { ctx, trackEvent, trackChannelEvent } = params;

  const handleReactionEvent = async (event: SlackReactionEvent, action: string) => {
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

      // Track channel events (not DM or group DM) for degraded state detection
      // Resolve actual channel type to distinguish private channels (G) from group DMs (mpim)
      // If resolveChannelName fails, be conservative: only treat as channel if we can definitively
      // identify it as a channel (C-prefix), not group (G-prefix could be private channel or group DM)
      const channelInfo = item.channel ? await ctx.resolveChannelName(item.channel) : {};
      const channelType = channelInfo?.type ?? inferSlackChannelType(item.channel);
      // Only treat as channel if explicitly resolved as "channel" or "group" from API,
      // or if inferred type is "channel" (C-prefix). Don't treat inferred "group" as channel
      // since it could be a group DM (mpim) which should not mask degraded state detection.
      const isChannel =
        channelInfo?.type === "channel" ||
        channelInfo?.type === "group" ||
        (channelType === "channel" && !channelInfo?.type);
      trackChannelEvent?.(isChannel);

      const actorInfoPromise: Promise<{ name?: string } | undefined> = event.user
        ? ctx.resolveUserName(event.user)
        : Promise.resolve(undefined);
      const authorInfoPromise: Promise<{ name?: string } | undefined> = event.item_user
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
    } catch (err) {
      ctx.runtime.error?.(danger(`slack reaction handler failed: ${String(err)}`));
    }
  };

  ctx.app.event(
    "reaction_added",
    async ({ event, body }: SlackEventMiddlewareArgs<"reaction_added">) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      await handleReactionEvent(event as SlackReactionEvent, "added");
    },
  );

  ctx.app.event(
    "reaction_removed",
    async ({ event, body }: SlackEventMiddlewareArgs<"reaction_removed">) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      await handleReactionEvent(event as SlackReactionEvent, "removed");
    },
  );
}
