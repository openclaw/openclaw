import type { ChannelOutboundAdapter } from "../types.js";
import { chunkText } from "../../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../../globals.js";
import { missingTargetError } from "../../../infra/outbound/target-errors.js";
import { sendPollWhatsApp } from "../../../web/outbound.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../../whatsapp/normalize.js";

export const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  resolveTarget: ({ to, allowFrom, mode }) => {
    const trimmed = to?.trim() ?? "";
    const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
    const hasWildcard = allowListRaw.includes("*");
    const allowList = allowListRaw
      .filter((entry) => entry !== "*")
      .map((entry) => normalizeWhatsAppTarget(entry))
      .filter((entry): entry is string => Boolean(entry));

    if (trimmed) {
      const normalizedTo = normalizeWhatsAppTarget(trimmed);
      if (!normalizedTo) {
        if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
          return { ok: true, to: allowList[0] };
        }
        return {
          ok: false,
          error: missingTargetError(
            "WhatsApp",
            "<E.164|group JID> or channels.whatsapp.allowFrom[0]",
          ),
        };
      }
      if (isWhatsAppGroupJid(normalizedTo)) {
        // Groups also restricted to allowlist when configured
        if (hasWildcard || allowList.length === 0 || allowList.includes(normalizedTo)) {
          return { ok: true, to: normalizedTo };
        }
        return {
          ok: false,
          error: new Error(`WhatsApp group ${trimmed} is not in the allowFrom list.`),
        };
      }
      if (hasWildcard || allowList.length === 0) {
        return { ok: true, to: normalizedTo };
      }
      if (allowList.includes(normalizedTo)) {
        return { ok: true, to: normalizedTo };
      }
      // Target not in allowlist — fallback for implicit, reject for explicit
      if (mode === "implicit" || mode === "heartbeat") {
        return { ok: true, to: allowList[0] };
      }
      return {
        ok: false,
        error: new Error(
          `WhatsApp target ${trimmed} is not in the allowFrom list. Allowed: ${allowListRaw.join(", ")}`,
        ),
      };
    }

    if (allowList.length > 0) {
      return { ok: true, to: allowList[0] };
    }
    return {
      ok: false,
      error: missingTargetError("WhatsApp", "<E.164|group JID> or channels.whatsapp.allowFrom[0]"),
    };
  },
  sendText: async ({ to, text, accountId, deps, gifPlayback }) => {
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, text, {
      verbose: false,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, deps, gifPlayback }) => {
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendPoll: async ({ to, poll, accountId }) =>
    await sendPollWhatsApp(to, poll, {
      verbose: shouldLogVerbose(),
      accountId: accountId ?? undefined,
    }),
};
