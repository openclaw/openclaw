import { buildChatChannelMetaById, type ChatChannelMeta } from "./chat-meta-shared.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "./ids.js";
import { listChannelCatalogEntries } from "../plugins/channel-catalog-registry.js";
import { buildManifestChannelMeta } from "./plugins/channel-meta.js";

let chatChannelMetaCache: Record<ChatChannelId, ChatChannelMeta> | null = null;

function getChatChannelMetaById(): Record<ChatChannelId, ChatChannelMeta> {
  chatChannelMetaCache ??= buildChatChannelMetaById();
  return chatChannelMetaCache;
}

export type { ChatChannelMeta };

export function listChatChannels(): ChatChannelMeta[] {
  const metaById = getChatChannelMetaById();
  return CHAT_CHANNEL_ORDER.map((id) => metaById[id]).filter((meta): meta is ChatChannelMeta =>
    Boolean(meta),
  );
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
  return getChatChannelMetaById()[id];
}
