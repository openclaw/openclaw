import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listBundledChannelCatalogEntries } from "./bundled-channel-catalog-read.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "./ids.js";
import { buildManifestChannelMeta } from "./plugins/channel-meta.js";
import type { ChannelMeta } from "./plugins/types.core.js";

/**
 * Metadata shown for built-in chat channels in setup, status, and selection UIs.
 */
export type ChatChannelMeta = ChannelMeta;

const CHAT_CHANNEL_ID_SET = new Set<string>(CHAT_CHANNEL_ORDER);

export function buildChatChannelMetaById(): Record<ChatChannelId, ChatChannelMeta> {
  const entries = new Map<ChatChannelId, ChatChannelMeta>();

  for (const entry of listBundledChannelCatalogEntries()) {
    // The catalog can contain non-chat bundled channels. Keep this map restricted to the
    // generated chat-channel order so setup/status views stay stable.
    const id = normalizeOptionalString(entry.id);
    if (!id || !CHAT_CHANNEL_ID_SET.has(id)) {
      continue;
    }
    const channel = entry.channel;
    const label = normalizeOptionalString(channel.label);
    if (!label) {
      throw new Error(`Missing label for bundled chat channel "${id}"`);
    }
    entries.set(
      id,
      buildManifestChannelMeta({
        id,
        channel,
        label,
        selectionLabel: normalizeOptionalString(channel.selectionLabel) || label,
        docsPath: normalizeOptionalString(channel.docsPath) || `/channels/${id}`,
        docsLabel: normalizeOptionalString(channel.docsLabel),
        blurb: normalizeOptionalString(channel.blurb) || "",
        detailLabel: normalizeOptionalString(channel.detailLabel),
        systemImage: normalizeOptionalString(channel.systemImage),
        arrayFieldMode: "non-empty",
      }),
    );
  }

  return Object.freeze(Object.fromEntries(entries)) as Record<ChatChannelId, ChatChannelMeta>;
}
