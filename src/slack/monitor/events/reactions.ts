import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { danger, logVerbose } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackReactionEvent } from "../types.js";

export function registerSlackReactionEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  const handleReactionEvent = async (event: SlackReactionEvent, action: string) => {
    try {
      const item = event.item;
      if (!item || item.type !== "message") {
        return;
      }

      const auth = await authorizeSlackSystemEventSender({
        ctx,
        senderId: event.user,
        channelId: item.channel,
      });
      if (!auth.allowed) {
        logVerbose(
          `slack: drop reaction sender ${event.user ?? "unknown"} channel=${item.channel ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`,
        );
        return;
      }

      const channelLabel = resolveSlackChannelLabel({
        channelId: item.channel,
        channelName: auth.channelName,
      });
      const actorInfo = event.user ? await ctx.resolveUserName(event.user) : undefined;
      const actorLabel = actorInfo?.name ?? event.user;
      const emojiLabel = event.reaction ?? "emoji";
      const authorInfo = event.item_user ? await ctx.resolveUserName(event.item_user) : undefined;
      const authorLabel = authorInfo?.name ?? event.item_user;
      const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${channelLabel} msg ${item.ts}`;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      const sessionKey = ctx.resolveSlackSystemEventSessionKey({
        channelId: item.channel,
        channelType: auth.channelType,
      });
      enqueueSystemEvent(text, {
        sessionKey,
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
