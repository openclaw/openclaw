import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  CHAT_CHANNEL_ALIASES,
  getChatChannelMeta,
  listChatChannelAliases,
  listChatChannels,
  normalizeChatChannelId,
  type ChatChannelMeta,
} from "./chat-meta.js";
import { CHANNEL_IDS, CHAT_CHANNEL_ORDER, type ChatChannelId } from "./ids.js";
import type { ChannelId, ChannelMeta } from "./plugins/types.js";
export { CHANNEL_IDS, CHAT_CHANNEL_ORDER } from "./ids.js";
export type { ChatChannelId } from "./ids.js";

type RegisteredChannelPluginEntry = {
  plugin: {
    id?: string | null;
    meta?: Pick<ChannelMeta, "aliases" | "markdownCapable"> | null;
  };
};

// [FORK] Last-known-good for registered channel plugin entries.
// When a peripheral plugin swap empties the global registry (image-gen, TTS, etc.),
// normalizeAnyChannelId → findRegisteredChannelPluginEntry → listRegisteredChannelPluginEntries
// returns [] → normalizeChannelId returns null → routeReply returns "Unknown channel: telegram".
// Same pattern as channels/plugins/registry.ts and channels/plugins/registry-loader.ts.
let lastGoodChannelPluginEntries: RegisteredChannelPluginEntry[] | null = null;

function listRegisteredChannelPluginEntries(): RegisteredChannelPluginEntry[] {
  const entries = getActivePluginRegistry()?.channels ?? [];
  // [FORK] If the registry is empty but we had entries before, return last-known-good.
  if (
    entries.length === 0 &&
    lastGoodChannelPluginEntries &&
    lastGoodChannelPluginEntries.length > 0
  ) {
    return lastGoodChannelPluginEntries;
  }
  // [FORK] Save as last-known-good when we have entries.
  if (entries.length > 0) {
    lastGoodChannelPluginEntries = entries;
  }
  return entries;
}

function findRegisteredChannelPluginEntry(
  normalizedKey: string,
): RegisteredChannelPluginEntry | undefined {
  return listRegisteredChannelPluginEntries().find((entry) => {
    const id = String(entry.plugin.id ?? "")
      .trim()
      .toLowerCase();
    if (id && id === normalizedKey) {
      return true;
    }
    return (entry.plugin.meta?.aliases ?? []).some(
      (alias) => alias.trim().toLowerCase() === normalizedKey,
    );
  });
}

function findRegisteredChannelPluginEntryById(
  id: string,
): RegisteredChannelPluginEntry | undefined {
  const normalizedId = normalizeChannelKey(id);
  if (!normalizedId) {
    return undefined;
  }
  return listRegisteredChannelPluginEntries().find(
    (entry) => normalizeChannelKey(entry.plugin.id) === normalizedId,
  );
}

const normalizeChannelKey = (raw?: string | null): string | undefined => {
  const normalized = raw?.trim().toLowerCase();
  return normalized || undefined;
};
export {
  CHAT_CHANNEL_ALIASES,
  getChatChannelMeta,
  listChatChannelAliases,
  listChatChannels,
  normalizeChatChannelId,
};

// Channel docking: prefer this helper in shared code. Importing from
// `src/channels/plugins/*` can eagerly load channel implementations.
export function normalizeChannelId(raw?: string | null): ChatChannelId | null {
  return normalizeChatChannelId(raw);
}

// Normalizes registered channel plugins (bundled or external).
//
// Keep this light: we do not import channel plugins here (those are "heavy" and can pull in
// monitors, web login, etc). The plugin registry must be initialized first.
export function normalizeAnyChannelId(raw?: string | null): ChannelId | null {
  const key = normalizeChannelKey(raw);
  if (!key) {
    return null;
  }
  return findRegisteredChannelPluginEntry(key)?.plugin.id ?? null;
}

export function listRegisteredChannelPluginIds(): ChannelId[] {
  return listRegisteredChannelPluginEntries().flatMap((entry) => {
    const id = entry.plugin.id?.trim();
    return id ? [id as ChannelId] : [];
  });
}

export function listRegisteredChannelPluginAliases(): string[] {
  return listRegisteredChannelPluginEntries().flatMap((entry) => entry.plugin.meta?.aliases ?? []);
}

export function getRegisteredChannelPluginMeta(
  id: string,
): Pick<ChannelMeta, "aliases" | "markdownCapable"> | null {
  return findRegisteredChannelPluginEntryById(id)?.plugin.meta ?? null;
}

export function formatChannelPrimerLine(meta: ChatChannelMeta): string {
  return `${meta.label}: ${meta.blurb}`;
}

export function formatChannelSelectionLine(
  meta: ChatChannelMeta,
  docsLink: (path: string, label?: string) => string,
): string {
  const docsPrefix = meta.selectionDocsPrefix ?? "Docs:";
  const docsLabel = meta.docsLabel ?? meta.id;
  const docs = meta.selectionDocsOmitLabel
    ? docsLink(meta.docsPath)
    : docsLink(meta.docsPath, docsLabel);
  const extras = (meta.selectionExtras ?? []).filter(Boolean).join(" ");
  return `${meta.label} — ${meta.blurb} ${docsPrefix ? `${docsPrefix} ` : ""}${docs}${extras ? ` ${extras}` : ""}`;
}
