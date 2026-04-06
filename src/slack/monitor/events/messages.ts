import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type {
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackThreadBroadcastEvent,
} from "../types.js";
import { markMessageHandled } from "./file-shared.js";

async function hydrateAppMentionMessage(params: {
  ctx: SlackMonitorContext;
  mention: SlackAppMentionEvent;
}): Promise<SlackMessageEvent> {
  const { ctx, mention } = params;
  if (!mention.ts || !mention.channel) {
    return mention as unknown as SlackMessageEvent;
  }
  try {
    const history = await ctx.app.client.conversations.history({
      channel: mention.channel,
      latest: mention.ts,
      oldest: mention.ts,
      inclusive: true,
      limit: 1,
    });
    const candidate = history.messages?.find((m) => m.ts === mention.ts) ?? history.messages?.[0];
    if (!candidate) {
      return mention as unknown as SlackMessageEvent;
    }
    const channelInfo = await ctx.resolveChannelName(mention.channel);
    return {
      type: "message",
      user: candidate.user ?? mention.user,
      bot_id: candidate.bot_id ?? mention.bot_id,
      subtype: candidate.subtype,
      username: candidate.username,
      text: candidate.text ?? mention.text ?? "",
      ts: candidate.ts ?? mention.ts,
      thread_ts: candidate.thread_ts ?? mention.thread_ts,
      event_ts: mention.event_ts,
      parent_user_id: candidate.parent_user_id,
      channel: mention.channel,
      channel_type: mention.channel_type ?? channelInfo?.type,
      files: (candidate as { files?: SlackMessageEvent["files"] }).files,
      attachments: (candidate as { attachments?: SlackMessageEvent["attachments"] }).attachments,
    } satisfies SlackMessageEvent;
  } catch {
    return mention as unknown as SlackMessageEvent;
  }
}

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  ctx.app.event("message", async ({ event, body }: SlackEventMiddlewareArgs<"message">) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const message = event as SlackMessageEvent;
      if (message.subtype === "message_changed") {
        const changed = event as SlackMessageChangedEvent;
        const channelId = changed.channel;
        const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
        const channelType = channelInfo?.type;
        if (
          !ctx.isChannelAllowed({
            channelId,
            channelName: channelInfo?.name,
            channelType,
          })
        ) {
          return;
        }
        const messageId = changed.message?.ts ?? changed.previous_message?.ts;
        const label = resolveSlackChannelLabel({
          channelId,
          channelName: channelInfo?.name,
        });
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
          channelId,
          channelType,
        });
        enqueueSystemEvent(`Slack message edited in ${label}.`, {
          sessionKey,
          contextKey: `slack:message:changed:${channelId ?? "unknown"}:${messageId ?? changed.event_ts ?? "unknown"}`,
        });
        return;
      }
      if (message.subtype === "message_deleted") {
        const deleted = event as SlackMessageDeletedEvent;
        const channelId = deleted.channel;
        const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
        const channelType = channelInfo?.type;
        if (
          !ctx.isChannelAllowed({
            channelId,
            channelName: channelInfo?.name,
            channelType,
          })
        ) {
          return;
        }
        const label = resolveSlackChannelLabel({
          channelId,
          channelName: channelInfo?.name,
        });
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
          channelId,
          channelType,
        });
        enqueueSystemEvent(`Slack message deleted in ${label}.`, {
          sessionKey,
          contextKey: `slack:message:deleted:${channelId ?? "unknown"}:${deleted.deleted_ts ?? deleted.event_ts ?? "unknown"}`,
        });
        return;
      }
      if (message.subtype === "thread_broadcast") {
        const thread = event as SlackThreadBroadcastEvent;
        const channelId = thread.channel;
        const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
        const channelType = channelInfo?.type;
        if (
          !ctx.isChannelAllowed({
            channelId,
            channelName: channelInfo?.name,
            channelType,
          })
        ) {
          return;
        }
        const label = resolveSlackChannelLabel({
          channelId,
          channelName: channelInfo?.name,
        });
        const messageId = thread.message?.ts ?? thread.event_ts;
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
          channelId,
          channelType,
        });
        enqueueSystemEvent(`Slack thread reply broadcast in ${label}.`, {
          sessionKey,
          contextKey: `slack:thread:broadcast:${channelId ?? "unknown"}:${messageId ?? "unknown"}`,
        });
        return;
      }

      await handleSlackMessage(message, { source: "message" });
      if (message.files?.length && message.ts) {
        markMessageHandled(message.ts);
      }
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
      const hydrated = await hydrateAppMentionMessage({ ctx, mention });
      await handleSlackMessage(hydrated, {
        source: "app_mention",
        wasMentioned: true,
      });
      if (hydrated.files?.length && hydrated.ts) {
        markMessageHandled(hydrated.ts);
      }
    } catch (err) {
      ctx.runtime.error?.(danger(`slack mention handler failed: ${String(err)}`));
    }
  });
}
