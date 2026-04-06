import { listChannelCatalogEntries } from "../plugins/channel-catalog-registry.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "./ids.js";
import { resolveChannelExposure } from "./plugins/exposure.js";
import type { ChannelMeta } from "./plugins/types.js";

export type ChatChannelMeta = ChannelMeta;

const CHAT_CHANNEL_ID_SET = new Set<string>(CHAT_CHANNEL_ORDER);

function toChatChannelMeta(params: {
  id: ChatChannelId;
  channel: PluginPackageChannel;
}): ChatChannelMeta {
  const label = params.channel.label?.trim();
  if (!label) {
    throw new Error(`Missing label for bundled chat channel "${params.id}"`);
  }
  const exposure = resolveChannelExposure(params.channel);

  return {
    id: params.id,
    label,
    selectionLabel: params.channel.selectionLabel?.trim() || label,
    docsPath: params.channel.docsPath?.trim() || `/channels/${params.id}`,
    docsLabel: params.channel.docsLabel?.trim() || undefined,
    blurb: params.channel.blurb?.trim() || "",
    ...(params.channel.aliases?.length ? { aliases: params.channel.aliases } : {}),
    ...(params.channel.order !== undefined ? { order: params.channel.order } : {}),
    ...(params.channel.selectionDocsPrefix !== undefined
      ? { selectionDocsPrefix: params.channel.selectionDocsPrefix }
      : {}),
    ...(params.channel.selectionDocsOmitLabel !== undefined
      ? { selectionDocsOmitLabel: params.channel.selectionDocsOmitLabel }
      : {}),
    ...(params.channel.selectionExtras?.length
      ? { selectionExtras: params.channel.selectionExtras }
      : {}),
    ...(params.channel.detailLabel?.trim()
      ? { detailLabel: params.channel.detailLabel.trim() }
      : {}),
    ...(params.channel.systemImage?.trim()
      ? { systemImage: params.channel.systemImage.trim() }
      : {}),
    ...(params.channel.markdownCapable !== undefined
      ? { markdownCapable: params.channel.markdownCapable }
      : {}),
    exposure,
    ...(params.channel.quickstartAllowFrom !== undefined
      ? { quickstartAllowFrom: params.channel.quickstartAllowFrom }
      : {}),
    ...(params.channel.forceAccountBinding !== undefined
      ? { forceAccountBinding: params.channel.forceAccountBinding }
      : {}),
    ...(params.channel.preferSessionLookupForAnnounceTarget !== undefined
      ? {
          preferSessionLookupForAnnounceTarget: params.channel.preferSessionLookupForAnnounceTarget,
        }
      : {}),
    ...(params.channel.preferOver?.length ? { preferOver: params.channel.preferOver } : {}),
  };
}

export function buildChatChannelMetaById(): Record<ChatChannelId, ChatChannelMeta> {
  const entries = new Map<ChatChannelId, ChatChannelMeta>();

  for (const entry of listChannelCatalogEntries({ origin: "bundled" })) {
    const channel = entry.channel;
    if (!channel) {
      continue;
    }
    const rawId = channel?.id?.trim();
    if (!rawId || !CHAT_CHANNEL_ID_SET.has(rawId)) {
      continue;
    }
    const id = rawId;
    entries.set(
      id,
      toChatChannelMeta({
        id,
        channel,
      }),
    );
  }

  return Object.freeze(Object.fromEntries(entries)) as Record<ChatChannelId, ChatChannelMeta>;
}
