import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackPinEvent } from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

async function handleSlackPinEvent(params: {
  ctx: SlackMonitorContext;
  body: unknown;
  event: unknown;
  action: "pinned" | "unpinned";
  contextKeySuffix: "added" | "removed";
  errorLabel: string;
}): Promise<void> {
  const { ctx, body, event, action, contextKeySuffix, errorLabel } = params;

  try {
    if (ctx.shouldDropMismatchedSlackEvent(body)) {
      return;
    }

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

export function registerSlackPinEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  ctx.app.event("pin_added", async ({ event, body }: SlackEventMiddlewareArgs<"pin_added">) => {
    await handleSlackPinEvent({
      ctx,
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
      body,
      event,
      action: "unpinned",
      contextKeySuffix: "removed",
      errorLabel: "pin removed",
    });
  });
}
