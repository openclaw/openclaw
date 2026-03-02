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
  // Slack may dispatch channel/group message subscriptions under typed event
  // names. Register explicit handlers so both delivery styles are supported.
  ctx.app.event(
    "message.channels",
    async ({ event, body }: SlackEventMiddlewareArgs<"message.channels">) => {
      await handleIncomingMessageEvent({ event, body });
    },
  );
  ctx.app.event(
    "message.groups",
    async ({ event, body }: SlackEventMiddlewareArgs<"message.groups">) => {
      await handleIncomingMessageEvent({ event, body });
    },
  );

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
