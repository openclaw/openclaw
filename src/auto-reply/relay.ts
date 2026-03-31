/**
 * Cross-channel relay: mirrors AI replies to configured relay targets.
 *
 * When a session has `session.relay.targets` configured, every reply that the
 * dispatcher delivers is also forwarded to those targets — skipping any target
 * whose channel matches the originating channel so we never echo back to the
 * sender.
 */

import type { OpenClawConfig } from "../config/config.js";
import type { ReplyDispatchKind, ReplyDispatcherOptions } from "./reply/reply-dispatcher.js";
import { isRoutableChannel, routeReply } from "./reply/route-reply.js";
import type { OriginatingChannelType } from "./templating.js";
import type { ReplyPayload } from "./types.js";

type RelayContext = {
  /** Channel the message originated from — relay targets matching this are skipped. */
  originatingChannel?: OriginatingChannelType;
  /** Session key for transcript mirroring on relay destinations. */
  sessionKey?: string;
  cfg: OpenClawConfig;
};

/**
 * Wraps a `deliver` callback so that after primary delivery, the payload is
 * also forwarded to any `session.relay.targets` that differ from the
 * originating channel.
 *
 * Relay errors are logged but never surface as delivery failures so that a
 * broken relay target cannot silently suppress the primary reply.
 */
export function wrapDeliverWithRelay(
  deliver: ReplyDispatcherOptions["deliver"],
  ctx: RelayContext,
): ReplyDispatcherOptions["deliver"] {
  const targets = ctx.cfg.session?.relay?.targets;
  if (!targets || targets.length === 0) {
    return deliver;
  }

  return async (payload: ReplyPayload, info: { kind: ReplyDispatchKind }) => {
    // Primary delivery first — always awaited so the caller's flow is unchanged.
    await deliver(payload, info);

    // Only relay final replies; skip tool results and intermediate blocks to
    // avoid flooding relay channels with partial streaming output.
    if (info.kind !== "final") {
      return;
    }

    for (const target of targets) {
      // Skip if this target's channel matches where the message came from.
      if (ctx.originatingChannel && target.channel === ctx.originatingChannel) {
        continue;
      }

      const channel = target.channel as OriginatingChannelType;
      if (!isRoutableChannel(channel)) {
        continue;
      }

      routeReply({
        payload,
        channel,
        to: target.to,
        accountId: target.accountId,
        sessionKey: ctx.sessionKey,
        cfg: ctx.cfg,
        // Mirror the relayed reply into the shared session transcript so both
        // channels see a consistent history.
        mirror: ctx.sessionKey != null,
      }).catch((err: unknown) => {
        // Relay errors are non-fatal: log but do not propagate.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[relay] failed to forward reply to ${target.channel}:${target.to} — ${msg}`);
      });
    }
  };
}
