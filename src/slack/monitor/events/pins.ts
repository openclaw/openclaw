import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { inferSlackChannelType } from "../context.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackPinEvent } from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

async function handleSlackPinEvent(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  trackChannelEvent?: (isChannel: boolean) => void;
  body: unknown;
  event: unknown;
  action: "pinned" | "unpinned";
  contextKeySuffix: "added" | "removed";
  errorLabel: string;
}): Promise<void> {
  const { ctx, trackEvent, trackChannelEvent, body, event, action, contextKeySuffix, errorLabel } =
    params;

  try {
    if (ctx.shouldDropMismatchedSlackEvent(body)) {
      return;
    }
    trackEvent?.();

    const payload = event as SlackPinEvent;
    const channelId = payload.channel_id;
    const ingressContext = await authorizeAndResolveSlackSystemEventContext({
      ctx,
      senderId: payload.user,
      channelId,
      eventKind: "pin",
    });
    if (!ingressContext) {
      return;
    }
    // Track channel events (not DM or group DM) for degraded state detection
    // Resolve actual channel type to distinguish private channels (G) from group DMs (mpim)
    // If resolveChannelName fails, be conservative: only treat as channel if we can definitively
    // identify it as a channel (C-prefix), not group (G-prefix could be private channel or group DM)
    const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
    const channelType = channelInfo?.type ?? inferSlackChannelType(channelId);
    // Only treat as channel if explicitly resolved as "channel" or "group" from API,
    // or if inferred type is "channel" (C-prefix). Don't treat inferred "group" as channel
    // since it could be a group DM (mpim) which should not mask degraded state detection.
    const isChannel =
      channelInfo?.type === "channel" ||
      channelInfo?.type === "group" ||
      (channelType === "channel" && !channelInfo?.type);
    trackChannelEvent?.(isChannel);

    const userInfo = payload.user ? await ctx.resolveUserName(payload.user) : {};
    const userLabel = userInfo?.name ?? payload.user ?? "someone";
    const itemType = payload.item?.type ?? "item";
    const messageId = payload.item?.message?.ts ?? payload.event_ts;
    enqueueSystemEvent(
      `Slack: ${userLabel} ${action} a ${itemType} in ${ingressContext.channelLabel}.`,
      {
        sessionKey: ingressContext.sessionKey,
        contextKey: `slack:pin:${contextKeySuffix}:${channelId ?? "unknown"}:${messageId ?? "unknown"}`,
      },
    );
  } catch (err) {
    ctx.runtime.error?.(danger(`slack ${errorLabel} handler failed: ${String(err)}`));
  }
}

export function registerSlackPinEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  trackChannelEvent?: (isChannel: boolean) => void;
}) {
  const { ctx, trackEvent, trackChannelEvent } = params;

  ctx.app.event("pin_added", async ({ event, body }: SlackEventMiddlewareArgs<"pin_added">) => {
    await handleSlackPinEvent({
      ctx,
      trackEvent,
      trackChannelEvent,
      body,
      event,
      action: "pinned",
      contextKeySuffix: "added",
      errorLabel: "pin added",
    });
  });

  ctx.app.event("pin_removed", async ({ event, body }: SlackEventMiddlewareArgs<"pin_removed">) => {
    await handleSlackPinEvent({
      ctx,
      trackEvent,
      trackChannelEvent,
      body,
      event,
      action: "unpinned",
      contextKeySuffix: "removed",
      errorLabel: "pin removed",
    });
  });
}
