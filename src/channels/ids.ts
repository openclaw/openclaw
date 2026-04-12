import { listChannelCatalogEntries } from "../plugins/channel-catalog-registry.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

export type ChatChannelId = string;

type BundledChatChannelEntry = {
  id: ChatChannelId;
  aliases: readonly string[];
  order: number;
};

function listBundledChatChannelEntries(): BundledChatChannelEntry[] {
  return listChannelCatalogEntries({ origin: "bundled" })
    .flatMap(({ channel }) => {
      const id = normalizeOptionalLowercaseString(channel.id);
      if (!id) {
        return [];
      }
      const aliases = (channel.aliases ?? [])
        .map((alias) => normalizeOptionalLowercaseString(alias))
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
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return null;
  }
  const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
  return CHAT_CHANNEL_ID_SET.has(resolved) ? resolved : null;
}
