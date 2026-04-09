import type { MsgContext } from "../../auto-reply/templating.js";
import { getChannelPlugin, listChannelPlugins } from "../../channels/plugins/index.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";

function resolveExplicitSessionKeyNormalizerCandidates(
  sessionKey: string,
  ctx: Pick<MsgContext, "From" | "Provider" | "Surface">,
): string[] {
  const normalizedProvider = ctx.Provider?.trim().toLowerCase();
  const normalizedSurface = ctx.Surface?.trim().toLowerCase();
  const normalizedFrom = (ctx.From ?? "").trim().toLowerCase();
  const candidates = new Set<string>();
  const maybeAdd = (value?: string | null) => {
    const normalized = normalizeMessageChannel(value);
    if (normalized) {
      candidates.add(normalized);
    }
  };
  maybeAdd(normalizedSurface);
  maybeAdd(normalizedProvider);
  maybeAdd(normalizedFrom.split(":", 1)[0]);
  for (const plugin of listChannelPlugins()) {
    const pluginId = normalizeMessageChannel(plugin.id);
    if (!pluginId) {
      continue;
    }
    if (sessionKey.startsWith(`${pluginId}:`) || sessionKey.includes(`:${pluginId}:`)) {
      candidates.add(pluginId);
    }
  }
  return [...candidates];
}

export function normalizeExplicitSessionKey(sessionKey: string, ctx: MsgContext): string {
  const normalized = sessionKey.trim().toLowerCase();
  for (const channelId of resolveExplicitSessionKeyNormalizerCandidates(normalized, ctx)) {
    const normalize = getChannelPlugin(channelId)?.messaging?.normalizeExplicitSessionKey;
    const next = normalize?.({ sessionKey: normalized, ctx });
    if (typeof next === "string" && next.trim()) {
      return next.trim().toLowerCase();
    }
  }
  return normalized;
}
