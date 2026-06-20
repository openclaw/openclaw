/**
 * Channel reasoning-lane capability resolver.
 *
 * Reads whether a channel advertises a dedicated reasoning (thinking) lane so
 * core reply dispatch can deliver durable `isReasoning` payloads to it and keep
 * suppressing them for channels without a lane.
 */
import { getLoadedChannelPlugin, normalizeChannelId } from "./registry.js";

export function channelSupportsReasoningPayloads(channel: string | undefined): boolean {
  const channelId = normalizeChannelId(channel);
  if (!channelId) {
    return false;
  }
  // Runs on every reply dispatch, so read only already-loaded plugins — never
  // fall through to bundled-runtime cold-load (getChannelPlugin). The delivery
  // target is loaded at delivery time; an unloaded channel fails closed.
  return getLoadedChannelPlugin(channelId)?.capabilities.reasoningPayloads === true;
}
