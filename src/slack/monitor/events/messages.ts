import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  const handleIncomingMessageEvent = async ({ event, body }: { event: unknown; body: unknown }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const message = event as SlackMessageEvent;
      const subtypeHandler = resolveSlackMessageSubtypeHandler(message);
      if (subtypeHandler) {
        const channelId = subtypeHandler.resolveChannelId(message);
        const ingressContext = await authorizeAndResolveSlackSystemEventContext({
          ctx,
          senderId: subtypeHandler.resolveSenderId(message),
          channelId,
          channelType: subtypeHandler.resolveChannelType(message),
          eventKind: subtypeHandler.eventKind,
        });
        if (!ingressContext) {
          return;
        }
        enqueueSystemEvent(subtypeHandler.describe(ingressContext.channelLabel), {
          sessionKey: ingressContext.sessionKey,
          contextKey: subtypeHandler.contextKey(message),
        });
        return;
      }

      await handleSlackMessage(message, { source: "message" });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack handler failed: ${String(err)}`));
    }
  };

  ctx.app.event("message", async ({ event, body }: SlackEventMiddlewareArgs<"message">) => {
    await handleIncomingMessageEvent({ event, body });
  });
  // Note: We intentionally do NOT register "message.channels" or "message.groups"
  // handlers here. While these are valid event types to SUBSCRIBE TO in your Slack
  // App's Event Subscriptions settings, @slack/bolt v4.6.0+ does not support
  // registering handlers for these specific sub-types using app.event().
  //
  // Bolt v4.6.0 validates handler registration and rejects these with:
  // "Although the document mentions 'message.channels', it is not a valid event type.
  //  Use 'message' instead. If you want to filter message events, you can use
  //  event.channel_type for it."
  //
  // The generic "message" handler above receives all message events. To distinguish
  // between channels, groups, DMs, etc., check event.channel_type in the handler.
  //
  // This is a Bolt framework change, not a Slack API deprecation. The event types
  // are still valid for subscription in Slack App settings, but Bolt only allows
  // registering handlers for the base "message" type.

  ctx.app.event("app_mention", async ({ event, body }: SlackEventMiddlewareArgs<"app_mention">) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const mention = event as SlackAppMentionEvent;
      await handleSlackMessage(mention as unknown as SlackMessageEvent, {
        source: "app_mention",
        wasMentioned: true,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack mention handler failed: ${String(err)}`));
    }
  });
}
