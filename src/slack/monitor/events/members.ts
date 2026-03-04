import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type { SlackMemberChannelEvent } from "../types.js";
import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { resolveSlackChannelLabel } from "../channel-config.js";

const DEFAULT_BOT_JOIN_PROMPT =
  "I've just been added to this channel. I'd like to set myself up properly here. " +
  "Could you let me know: " +
  "1) Should I require a direct @mention to respond, or respond to all messages in this channel? " +
  "2) Should I respond to messages from everyone, or only specific users?";

export function registerSlackMemberEvents(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  handleSlackMessage?: SlackMessageHandler;
}) {
  const { ctx, account, handleSlackMessage } = params;

  ctx.app.event(
    "member_joined_channel",
    async ({ event, body }: SlackEventMiddlewareArgs<"member_joined_channel">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        const payload = event as SlackMemberChannelEvent;
        const channelId = payload.channel;
        const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
        const channelType = payload.channel_type ?? channelInfo?.type;
        if (
          !ctx.isChannelAllowed({
            channelId,
            channelName: channelInfo?.name,
            channelType,
          })
        ) {
          return;
        }
        const userInfo = payload.user ? await ctx.resolveUserName(payload.user) : {};
        const userLabel = userInfo?.name ?? payload.user ?? "someone";
        const label = resolveSlackChannelLabel({
          channelId,
          channelName: channelInfo?.name,
        });
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
          channelId,
          channelType,
        });
        enqueueSystemEvent(`Slack: ${userLabel} joined ${label}.`, {
          sessionKey,
          contextKey: `slack:member:joined:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`,
        });

        // When the bot itself joins a channel and onBotJoinChannel is enabled,
        // trigger an AI response so the bot can greet users and ask about
        // configuration preferences (requireMention, user allowlists, etc.)
        // without requiring a manual first message from a human.
        const isBotJoin = Boolean(ctx.botUserId && payload.user === ctx.botUserId);
        const onBotJoinCfg = account.config.onBotJoinChannel;
        if (isBotJoin && onBotJoinCfg?.enabled && handleSlackMessage && channelId) {
          const prompt = onBotJoinCfg.prompt?.trim() || DEFAULT_BOT_JOIN_PROMPT;
          // Infer channel_type from channel ID prefix if not provided by the event.
          const resolvedChannelType = channelType ?? (channelId.startsWith("D") ? "im" : "channel");
          // Synthetic message acts as the trigger for the AI run.
          // We use wasMentioned: true to bypass mention-gating, bypassUserAuth: true to
          // skip channel user-allowlist gating (this is a system action, not a user message),
          // and the bot's own user ID so it passes bot-message identity checks.
          // event_ts is stable across Slack retries, ensuring deduplication works correctly.
          const syntheticMessage: SlackMessageEvent = {
            type: "message",
            channel: channelId,
            channel_type: resolvedChannelType as SlackMessageEvent["channel_type"],
            user: ctx.botUserId ?? "SYSTEM_BOT_JOIN",
            text: prompt,
            ts: payload.event_ts ?? String(Date.now() / 1000),
          };
          await handleSlackMessage(syntheticMessage, {
            source: "app_mention",
            wasMentioned: true,
            bypassUserAuth: true,
          });
        }
      } catch (err) {
        ctx.runtime.error?.(danger(`slack join handler failed: ${String(err)}`));
      }
    },
  );

  ctx.app.event(
    "member_left_channel",
    async ({ event, body }: SlackEventMiddlewareArgs<"member_left_channel">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        const payload = event as SlackMemberChannelEvent;
        const channelId = payload.channel;
        const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
        const channelType = payload.channel_type ?? channelInfo?.type;
        if (
          !ctx.isChannelAllowed({
            channelId,
            channelName: channelInfo?.name,
            channelType,
          })
        ) {
          return;
        }
        const userInfo = payload.user ? await ctx.resolveUserName(payload.user) : {};
        const userLabel = userInfo?.name ?? payload.user ?? "someone";
        const label = resolveSlackChannelLabel({
          channelId,
          channelName: channelInfo?.name,
        });
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
          channelId,
          channelType,
        });
        enqueueSystemEvent(`Slack: ${userLabel} left ${label}.`, {
          sessionKey,
          contextKey: `slack:member:left:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`,
        });
      } catch (err) {
        ctx.runtime.error?.(danger(`slack leave handler failed: ${String(err)}`));
      }
    },
  );
}
