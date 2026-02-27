import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type {
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackThreadBroadcastEvent,
} from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  const resolveChangedSenderId = (changed: SlackMessageChangedEvent): string | undefined =>
    changed.message?.user ??
    changed.previous_message?.user ??
    changed.message?.bot_id ??
    changed.previous_message?.bot_id;
  const resolveDeletedSenderId = (deleted: SlackMessageDeletedEvent): string | undefined =>
    deleted.previous_message?.user ?? deleted.previous_message?.bot_id;
  const resolveThreadBroadcastSenderId = (thread: SlackThreadBroadcastEvent): string | undefined =>
    thread.user ?? thread.message?.user ?? thread.message?.bot_id;

  ctx.app.event("message", async ({ event, body }: SlackEventMiddlewareArgs<"message">) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const message = event as SlackMessageEvent;
      if (message.subtype === "message_changed") {
        const changed = event as SlackMessageChangedEvent;
        const channelId = changed.channel;
        const ingressContext = await authorizeAndResolveSlackSystemEventContext({
          ctx,
          senderId: resolveChangedSenderId(changed),
          channelId,
          eventKind: "message_changed",
        });
        if (!ingressContext) {
          return;
        }
        const messageId = changed.message?.ts ?? changed.previous_message?.ts;
        enqueueSystemEvent(`Slack message edited in ${ingressContext.channelLabel}.`, {
          sessionKey: ingressContext.sessionKey,
          contextKey: `slack:message:changed:${channelId ?? "unknown"}:${messageId ?? changed.event_ts ?? "unknown"}`,
        });
        return;
      }
      if (message.subtype === "message_deleted") {
        const deleted = event as SlackMessageDeletedEvent;
        const channelId = deleted.channel;
        const ingressContext = await authorizeAndResolveSlackSystemEventContext({
          ctx,
          senderId: resolveDeletedSenderId(deleted),
          channelId,
          eventKind: "message_deleted",
        });
        if (!ingressContext) {
          return;
        }
        enqueueSystemEvent(`Slack message deleted in ${ingressContext.channelLabel}.`, {
          sessionKey: ingressContext.sessionKey,
          contextKey: `slack:message:deleted:${channelId ?? "unknown"}:${deleted.deleted_ts ?? deleted.event_ts ?? "unknown"}`,
        });
        return;
      }
      if (message.subtype === "thread_broadcast") {
        const thread = event as SlackThreadBroadcastEvent;
        const channelId = thread.channel;
        const ingressContext = await authorizeAndResolveSlackSystemEventContext({
          ctx,
          senderId: resolveThreadBroadcastSenderId(thread),
          channelId,
          eventKind: "thread_broadcast",
        });
        if (!ingressContext) {
          return;
        }
        const messageId = thread.message?.ts ?? thread.event_ts;
        enqueueSystemEvent(`Slack thread reply broadcast in ${ingressContext.channelLabel}.`, {
          sessionKey: ingressContext.sessionKey,
          contextKey: `slack:thread:broadcast:${channelId ?? "unknown"}:${messageId ?? "unknown"}`,
        });
        return;
      }

      await handleSlackMessage(message, { source: "message" });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack handler failed: ${String(err)}`));
    }
  });

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
