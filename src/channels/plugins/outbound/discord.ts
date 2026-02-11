import type { ChannelOutboundAdapter } from "../types.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveStorePath,
} from "../../../config/sessions.js";
import { sendMessageDiscord, sendPollDiscord } from "../../../discord/send.js";
import { parseDiscordTarget } from "../../../discord/targets.js";
import { deliveryContextFromSession } from "../../../utils/delivery-context.js";

/**
 * Try to resolve a Discord delivery target from the main session's last
 * delivery context. This handles the case where a cron job or announce flow
 * specifies a bare user ID but the session already knows the DM channel.
 */
function resolveDiscordTargetFromSession(
  cfg: import("../../../config/config.js").OpenClawConfig | undefined,
): string | undefined {
  if (!cfg) {
    return undefined;
  }
  try {
    const mainKey = resolveAgentMainSessionKey({ cfg, agentId: "main" });
    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
    const store = loadSessionStore(storePath);
    const entry = store[mainKey];
    const ctx = deliveryContextFromSession(entry);
    if (ctx?.to && ctx.channel === "discord") {
      return ctx.to;
    }
  } catch {
    // Session lookup failed — no fallback available
  }
  return undefined;
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  resolveTarget: ({ cfg, to, allowFrom: _allowFrom, mode }) => {
    const trimmed = to?.trim() ?? "";
    if (!trimmed) {
      // Implicit mode: try to resolve from session's last delivery context
      if (mode === "implicit" || mode === "heartbeat") {
        const fallback = resolveDiscordTargetFromSession(cfg);
        if (fallback) {
          return { ok: true, to: fallback };
        }
      }
      return {
        ok: false,
        error: new Error(
          'Discord target is required. Use "user:<id>" for DMs or "channel:<id>" for channel messages.',
        ),
      };
    }
    // Validate the target by parsing it — this catches ambiguous bare numeric IDs early
    // instead of failing silently at send time.
    try {
      const parsed = parseDiscordTarget(trimmed);
      if (parsed) {
        // Re-format with the proper prefix so downstream send never sees ambiguous IDs
        return { ok: true, to: `${parsed.kind}:${parsed.id}` };
      }
    } catch {
      // Bare numeric ID — ambiguous. Try the session's lastTo as a fallback.
      const fallback = resolveDiscordTargetFromSession(cfg);
      if (fallback) {
        return { ok: true, to: fallback };
      }
      return {
        ok: false,
        error: new Error(
          `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
        ),
      };
    }
    return { ok: true, to: trimmed };
  },
  sendText: async ({ to, text, accountId, deps, replyToId }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, text, {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendPoll: async ({ to, poll, accountId }) =>
    await sendPollDiscord(to, poll, {
      accountId: accountId ?? undefined,
    }),
};
