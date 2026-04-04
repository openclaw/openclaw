import { listBundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";

export type ChatChannelId = string;

type BundledChatChannelEntry = {
  id: ChatChannelId;
  aliases: readonly string[];
  order: number;
};

function normalizeChannelKey(raw?: string | null): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  return normalized || undefined;
}

function listBundledChatChannelEntries(): BundledChatChannelEntry[] {
  return listBundledPluginMetadata({
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  })
    .flatMap((entry) => {
      const channel =
        entry.packageManifest && "channel" in entry.packageManifest
          ? entry.packageManifest.channel
          : undefined;
      const id = normalizeChannelKey(channel?.id);
      if (!channel || !id) {
        return [];
      }
      const aliases = (channel.aliases ?? [])
        .map((alias) => normalizeChannelKey(alias))
        .filter((alias): alias is string => Boolean(alias));
      return [
        {
          id,
          aliases,
          order: typeof channel.order === "number" ? channel.order : Number.MAX_SAFE_INTEGER,
        },
      ];
    })
    .toSorted(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id, "en", { sensitivity: "base" }),
    );
}

const BUNDLED_CHAT_CHANNEL_ENTRIES = Object.freeze(listBundledChatChannelEntries());
const CHAT_CHANNEL_ID_SET = new Set(BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id));

export const CHAT_CHANNEL_ORDER = Object.freeze(
  BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id),
);

export const CHANNEL_IDS = CHAT_CHANNEL_ORDER;

export const CHAT_CHANNEL_ALIASES: Record<string, ChatChannelId> = Object.freeze(
  Object.fromEntries(
    BUNDLED_CHAT_CHANNEL_ENTRIES.flatMap((entry) =>
      entry.aliases.map((alias) => [alias, entry.id] as const),
    ),
  ),
) as Record<string, ChatChannelId>;

export function listChatChannelAliases(): string[] {
  return Object.keys(CHAT_CHANNEL_ALIASES);
}

export function normalizeChatChannelId(raw?: string | null): ChatChannelId | null {
  const normalized = normalizeChannelKey(raw);
  if (!normalized) {
    return null;
  }
  const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
  return CHAT_CHANNEL_ID_SET.has(resolved) ? resolved : null;
}
