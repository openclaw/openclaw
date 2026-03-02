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

const MESSAGE_EVENT_NAMES = [
  "message",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
] as const;
const MAX_RECENT_MESSAGE_EVENT_KEYS = 256;

type SlackMessageEventBody = {
  event_id?: unknown;
};

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

  const recentEventKeys: string[] = [];
  const recentEventSet = new Set<string>();

  const resolveDeduplicationKey = (message: SlackMessageEvent, body: unknown): string | null => {
    const bodyEventId =
      body && typeof body === "object" ? (body as SlackMessageEventBody).event_id : undefined;
    const eventId = typeof bodyEventId === "string" ? bodyEventId : "";
    const messageTs = message.ts ?? message.event_ts;
    if (!eventId && !messageTs) {
      return null;
    }
    return `${eventId || "no-event-id"}:${message.channel ?? "unknown"}:${messageTs ?? "unknown"}:${message.subtype ?? "none"}`;
  };

  const shouldSkipDuplicateMessageEvent = (message: SlackMessageEvent, body: unknown): boolean => {
    const dedupKey = resolveDeduplicationKey(message, body);
    if (!dedupKey) {
      return false;
    }
    if (recentEventSet.has(dedupKey)) {
      return true;
    }
    recentEventSet.add(dedupKey);
    recentEventKeys.push(dedupKey);
    if (recentEventKeys.length > MAX_RECENT_MESSAGE_EVENT_KEYS) {
      const removed = recentEventKeys.shift();
      if (removed) {
        recentEventSet.delete(removed);
      }
    }
    return false;
  };

  const registerMessageHandler = (eventName: (typeof MESSAGE_EVENT_NAMES)[number]) => {
    ctx.app.event(
      eventName as never,
      async ({ event, body }: SlackEventMiddlewareArgs<"message">) => {
        try {
          if (ctx.shouldDropMismatchedSlackEvent(body)) {
            return;
          }

          const message = event as SlackMessageEvent;
          if (shouldSkipDuplicateMessageEvent(message, body)) {
            return;
          }
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
      },
    );
  };

  for (const eventName of MESSAGE_EVENT_NAMES) {
    registerMessageHandler(eventName);
  }

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
