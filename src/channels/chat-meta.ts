import { buildChatChannelMetaById, type ChatChannelMeta } from "./chat-meta-shared.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "./ids.js";
import { listChannelCatalogEntries } from "../plugins/channel-catalog-registry.js";
import { buildManifestChannelMeta } from "./plugins/channel-meta.js";

const CHAT_CHANNEL_META = buildChatChannelMetaById();

export type { ChatChannelMeta };

export function listChatChannels(): ChatChannelMeta[] {
  return CHAT_CHANNEL_ORDER.map((id) => CHAT_CHANNEL_META[id]);
}

export function listAllChatChannels(): ChatChannelMeta[] {
  const bundled = listChatChannels();
  const seen = new Set(bundled.map((m) => m.id));
  const extra: ChatChannelMeta[] = [];

  for (const entry of listChannelCatalogEntries()) {
    const id = entry.channel?.id?.toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const label = entry.channel?.label?.trim();
    if (!label) continue;

    const meta = buildManifestChannelMeta({
      id,
      channel: entry.channel!,
      label,
      selectionLabel: entry.channel?.selectionLabel?.trim() || label,
      docsPath: entry.channel?.docsPath?.trim() || `/channels/${id}`,
      docsLabel: entry.channel?.docsLabel,
      blurb: entry.channel?.blurb?.trim() || "",
      detailLabel: entry.channel?.detailLabel?.trim(),
      systemImage: entry.channel?.systemImage,
      arrayFieldMode: "defined",
      selectionDocsPrefixMode: "truthy",
    });
    extra.push(meta);
  }

  return [...bundled, ...extra];
}

export function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta {
  return CHAT_CHANNEL_META[id];
}
