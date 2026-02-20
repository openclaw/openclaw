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

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  const resolveSlackChannelSystemEventTarget = async (channelId: string | undefined) => {
    const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
    const channelType = channelInfo?.type;
    if (
      !ctx.isChannelAllowed({
        channelId,
        channelName: channelInfo?.name,
        channelType,
      })
    ) {
      return null;
    }

    const label = resolveSlackChannelLabel({
      channelId,
      channelName: channelInfo?.name,
    });
    const sessionKey = ctx.resolveSlackSystemEventSessionKey({
      channelId,
      channelType,
    });

    return { channelInfo, channelType, label, sessionKey };
  };

  ctx.app.event("message", async ({ event, body }: SlackEventMiddlewareArgs<"message">) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const message = event as SlackMessageEvent;
      if (message.subtype === "message_changed") {
        const changed = event as SlackMessageChangedEvent;
        const channelId = changed.channel;
        const target = await resolveSlackChannelSystemEventTarget(channelId);
        if (!target) {
          return;
        }
        const messageId = changed.message?.ts ?? changed.previous_message?.ts;

        // Detect tombstone: Slack sends message_changed (not message_deleted)
        // when a thread parent is deleted. The new message has subtype "tombstone".
        const isTombstone = changed.message?.subtype === "tombstone";
        const hadThread = (changed.previous_message?.reply_count ?? 0) > 0;
        if (isTombstone && hadThread && channelId && messageId) {
          ctx.runtime.log?.(
            `[message_changed/tombstone] thread parent deleted: channel=${channelId} thread=${messageId}`,
          );
          void (async () => {
            try {
              const { deleteSlackThreadReplies } = await import("../../actions.js");
              const userTokenForDelete =
                ctx.userToken && !ctx.userTokenReadOnly ? ctx.userToken : undefined;
              const result = await deleteSlackThreadReplies(channelId, messageId, {
                botUserId: ctx.botUserId,
                userToken: userTokenForDelete,
              });
              const totalDeleted = result.deletedBot.length + result.deletedUser.length;
              if (totalDeleted > 0) {
                ctx.logger.info(
                  `Deleted ${result.deletedBot.length} bot + ${result.deletedUser.length} user reply(ies) in thread ${messageId} (tombstone)` +
                    (result.failed.length > 0 ? ` (${result.failed.length} failed)` : ""),
                );
              } else {
                ctx.runtime.log?.(
                  `[message_changed/tombstone] no replies found in thread ${messageId}`,
                );
              }
            } catch (err) {
              ctx.logger.warn(
                `Failed to clean up replies after tombstone detection: ${String(err)}`,
              );
            }
          })();
          enqueueSystemEvent(`Slack message deleted in ${target.label} (thread parent removed).`, {
            sessionKey: target.sessionKey,
            contextKey: `slack:message:deleted:${channelId}:${messageId}`,
          });
          return;
        }

        enqueueSystemEvent(`Slack message edited in ${target.label}.`, {
          sessionKey: target.sessionKey,
          contextKey: `slack:message:changed:${channelId ?? "unknown"}:${messageId ?? changed.event_ts ?? "unknown"}`,
        });
        return;
      }
      if (message.subtype === "message_deleted") {
        const deleted = event as SlackMessageDeletedEvent;
        const channelId = deleted.channel;
        const target = await resolveSlackChannelSystemEventTarget(channelId);
        if (!target) {
          return;
        }
        enqueueSystemEvent(`Slack message deleted in ${target.label}.`, {
          sessionKey: target.sessionKey,
          contextKey: `slack:message:deleted:${channelId ?? "unknown"}:${deleted.deleted_ts ?? deleted.event_ts ?? "unknown"}`,
        });
        // Clean up replies when parent message is deleted
        if (deleted.deleted_ts && channelId) {
          void (async () => {
            try {
              const { deleteSlackThreadReplies } = await import("../../actions.js");
              const userTokenForDelete =
                ctx.userToken && !ctx.userTokenReadOnly ? ctx.userToken : undefined;
              ctx.runtime.log?.(
                `[message_deleted] cleaning up replies: channel=${channelId} thread=${deleted.deleted_ts}` +
                  (userTokenForDelete ? " (with user token)" : " (bot only)"),
              );
              const result = await deleteSlackThreadReplies(channelId, deleted.deleted_ts!, {
                botUserId: ctx.botUserId,
                userToken: userTokenForDelete,
              });
              const totalDeleted = result.deletedBot.length + result.deletedUser.length;
              if (totalDeleted > 0) {
                ctx.logger.info(
                  `Deleted ${result.deletedBot.length} bot + ${result.deletedUser.length} user reply(ies) in thread ${deleted.deleted_ts} (parent deleted)` +
                    (result.failed.length > 0 ? ` (${result.failed.length} failed)` : ""),
                );
              } else {
                ctx.runtime.log?.(
                  `[message_deleted] no replies found in thread ${deleted.deleted_ts}`,
                );
              }
            } catch (err) {
              ctx.logger.warn(
                `Failed to clean up replies after parent message deletion: ${String(err)}`,
              );
            }
          })();
        }
        return;
      }
      if (message.subtype === "thread_broadcast") {
        const thread = event as SlackThreadBroadcastEvent;
        const channelId = thread.channel;
        const target = await resolveSlackChannelSystemEventTarget(channelId);
        if (!target) {
          return;
        }
        const messageId = thread.message?.ts ?? thread.event_ts;
        enqueueSystemEvent(`Slack thread reply broadcast in ${target.label}.`, {
          sessionKey: target.sessionKey,
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
