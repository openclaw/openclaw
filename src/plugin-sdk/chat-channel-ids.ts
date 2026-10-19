/**
 * Canonical bundled chat-channel id list.
 *
 * Mirrors the channel catalog ids that can be passed to the inbound-envelope
 * formatter (src/auto-reply/envelope.ts -> formatInboundEnvelope ->
 * formatAgentEnvelope) for its leading `[<channel> ...]` header. Plugins that
 * need to recognize an envelope-prefixed message (for example a memory plugin
 * filtering envelope sludge out of long-term capture) should not hardcode their
 * own channel-id table that can drift from the catalog.
 *
 * The list is derived from the same bundled/official channel catalog reader as
 * runtime channel metadata so catalog-only channels stay covered even when they
 * do not have a generated config metadata entry.
 */
import { listBundledChannelCatalogEntries } from "../channels/bundled-channel-catalog-read.js";

const BUNDLED_CHAT_CHANNEL_ENTRIES = listBundledChannelCatalogEntries();

/** Bundled chat-channel ids from the official channel catalog. */
export const BUNDLED_CHAT_CHANNEL_IDS = Object.freeze(
  BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id),
);

/**
 * Channel ids, labels, and aliases that can appear as inbound-envelope prefixes.
 * Consumers should use this for envelope cleanup instead of hardcoding channel names.
 */
export const BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES = Object.freeze(
  (() => {
    const prefixes = new Map<string, string>();
    for (const entry of BUNDLED_CHAT_CHANNEL_ENTRIES) {
      for (const raw of [entry.id, entry.channel.label, ...entry.aliases]) {
        const value = raw?.trim();
        const key = value?.toLocaleLowerCase("en-US");
        // Envelope matching is case-insensitive; retain the first catalog spelling.
        if (value && key && !prefixes.has(key)) {
          prefixes.set(key, value);
        }
      }
    }
    return [...prefixes.values()];
  })(),
);
export type { ChatChannelId } from "../channels/ids.js";
