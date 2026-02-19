import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type {
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackThreadBroadcastEvent,
} from "../types.js";
import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import { writeSlackDiag, writeSlackDiagKv } from "../diag.js";
import { markMessageHandled } from "./file-shared.js";

writeSlackDiag("diag init: messages.ts loaded");

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
      const diag = event as SlackMessageEvent;
      writeSlackDiagKv("diag slack message ingress", {
        ch: diag.channel ?? "?",
        ts: diag.ts ?? diag.event_ts ?? "?",
        subtype: diag.subtype ?? "-",
        files: diag.files?.length ?? 0,
        user: diag.user ?? diag.bot_id ?? "?",
      });
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        writeSlackDiagKv("diag slack message drop(mismatch)", {
          ch: diag.channel ?? "?",
          ts: diag.ts ?? diag.event_ts ?? "?",
        });
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
      writeSlackDiagKv("diag slack message handled", {
        ch: message.channel ?? "?",
        ts: message.ts ?? message.event_ts ?? "?",
        subtype: message.subtype ?? "-",
        files: message.files?.length ?? 0,
      });
      if (message.files?.length && message.ts) {
        markMessageHandled(message.ts);
        writeSlackDiagKv("diag slack message markMessageHandled", {
          ch: message.channel ?? "?",
          ts: message.ts,
        });
      }
    } catch (err) {
      ctx.runtime.error?.(danger(`slack handler failed: ${String(err)}`));
    }
  });

  ctx.app.event("app_mention", async ({ event, body }: SlackEventMiddlewareArgs<"app_mention">) => {
    try {
      const mentionDiag = event as SlackAppMentionEvent;
      writeSlackDiagKv("diag slack app_mention ingress", {
        ch: mentionDiag.channel ?? "?",
        ts: mentionDiag.ts ?? mentionDiag.event_ts ?? "?",
        user: mentionDiag.user ?? "?",
      });
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        writeSlackDiagKv("diag slack app_mention drop(mismatch)", {
          ch: mentionDiag.channel ?? "?",
          ts: mentionDiag.ts ?? mentionDiag.event_ts ?? "?",
        });
        return;
      }

      const mention = event as SlackAppMentionEvent;
      const hydrated = await hydrateAppMentionMessage({ ctx, mention });
      writeSlackDiagKv("diag slack app_mention hydrated", {
        ch: hydrated.channel ?? "?",
        ts: hydrated.ts ?? hydrated.event_ts ?? "?",
        files: hydrated.files?.length ?? 0,
        subtype: hydrated.subtype ?? "-",
      });
      await handleSlackMessage(hydrated, {
        source: "app_mention",
        wasMentioned: true,
      });
      writeSlackDiagKv("diag slack app_mention handled", {
        ch: hydrated.channel ?? "?",
        ts: hydrated.ts ?? hydrated.event_ts ?? "?",
        files: hydrated.files?.length ?? 0,
      });
      if (hydrated.files?.length && hydrated.ts) {
        markMessageHandled(hydrated.ts);
        writeSlackDiagKv("diag slack app_mention markMessageHandled", {
          ch: hydrated.channel ?? "?",
          ts: hydrated.ts,
        });
      }
    } catch (err) {
      ctx.runtime.error?.(danger(`slack mention handler failed: ${String(err)}`));
    }
  });
}
