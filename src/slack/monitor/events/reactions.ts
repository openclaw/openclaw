import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { danger, logVerbose } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackReactionEvent } from "../types.js";

export function registerSlackReactionEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  const handleReactionEvent = async (event: SlackReactionEvent, action: "added" | "removed") => {
    try {
      const item = event.item;
      if (!item || item.type !== "message") {
        return;
      }

      const channelInfo = item.channel ? await ctx.resolveChannelName(item.channel) : {};
      const channelType = channelInfo?.type;
      if (
        !ctx.isChannelAllowed({
          channelId: item.channel,
          channelName: channelInfo?.name,
          channelType,
        })
      ) {
        return;
      }

      const channelLabel = resolveSlackChannelLabel({
        channelId: item.channel,
        channelName: channelInfo?.name,
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
        channelType,
      });

      const contextKey = `slack:reaction:${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}`;

      if (ctx.reactionDelivery === "immediate") {
        try {
          const { getReactionDebouncer } =
            await import("../../../infra/reaction-dispatch/index.js");
          const debouncer = getReactionDebouncer(ctx.reactionBundleWindowMs);

          let reactedMessageContent: string | undefined;
          let reactedMessageAuthor: string | undefined;
          if (ctx.reactionIncludeMessage && item.channel && item.ts) {
            try {
              const history = await ctx.app.client.conversations.history({
                token: ctx.botToken,
                channel: item.channel,
                latest: item.ts,
                limit: 1,
                inclusive: true,
              });
              const msg = history.messages?.[0];
              if (msg) {
                reactedMessageContent = msg.text || undefined;
                const msgUser = msg.user ? await ctx.resolveUserName(msg.user) : undefined;
                reactedMessageAuthor = msgUser?.name ?? msg.user;
              }
            } catch (err) {
              logVerbose(`slack: failed to fetch reacted message: ${String(err)}`);
            }
          }

          await debouncer.enqueue(
            {
              emoji: emojiLabel,
              actorLabel: actorLabel ?? "unknown",
              actorId: event.user,
              action,
              ts: Date.now(),
            },
            {
              channel: "slack",
              accountId: ctx.accountId,
              sessionKey,
              messageId: item.ts ?? "unknown",
              reactedMessageContent,
              reactedMessageAuthor,
              conversationLabel: channelLabel,
            },
          );
        } catch (err) {
          logVerbose(danger(`slack reaction dispatch failed: ${String(err)}`));
          // Fallback to deferred on dispatch failure
          enqueueSystemEvent(text, {
            sessionKey,
            contextKey,
          });
        }
      } else {
        enqueueSystemEvent(text, {
          sessionKey,
          contextKey: `slack:reaction:${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}`,
        });
      }
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
