import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { listChannelCatalogEntries } from "../plugins/channel-catalog-registry.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

type ChannelCatalogEntryLike = {
  openclaw?: {
    channel?: PluginPackageChannel;
  };
};

type BundledChannelCatalogEntry = {
  id: string;
  channel: PluginPackageChannel;
  aliases: readonly string[];
  order: number;
};

const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");
const officialCatalogFileCache = new Map<string, ChannelCatalogEntryLike[] | null>();

function listPackageRoots(): string[] {
  const roots: string[] = [];
  for (const root of [
    resolveOpenClawPackageRootSync({ cwd: process.cwd() }),
    resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
  ]) {
    if (root && !roots.includes(root)) {
      roots.push(root);
    }
  }
  return roots;
}

function readBundledExtensionCatalogEntriesSync(): PluginPackageChannel[] {
  try {
    return listChannelCatalogEntries({ origin: "bundled" }).map((entry) => entry.channel);
  } catch {
    return [];
  }
}

function readOfficialCatalogFileSync(): ChannelCatalogEntryLike[] {
  for (const packageRoot of listPackageRoots()) {
    const candidate = path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH);
    const cached = officialCatalogFileCache.get(candidate);
    if (cached !== undefined) {
      if (cached) {
        return cached;
      }
      continue;
    }
    if (!fs.existsSync(candidate)) {
      officialCatalogFileCache.set(candidate, null);
      continue;
    }
    try {
      const payload = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        entries?: unknown;
      };
      const entries = Array.isArray(payload.entries)
        ? (payload.entries as ChannelCatalogEntryLike[])
        : [];
      officialCatalogFileCache.set(candidate, entries);
      return entries;
    } catch {
      officialCatalogFileCache.set(candidate, null);
      continue;
    }
  }
  return [];
}

function isChannelCatalogEntryLike(
  entry: ChannelCatalogEntryLike | PluginPackageChannel,
): entry is ChannelCatalogEntryLike {
  return "openclaw" in entry;
}

function toBundledChannelEntry(
  entry: ChannelCatalogEntryLike | PluginPackageChannel,
): BundledChannelCatalogEntry | null {
  const channel: PluginPackageChannel | undefined = isChannelCatalogEntryLike(entry)
    ? entry.openclaw?.channel
    : entry;
  const id = normalizeOptionalLowercaseString(channel?.id);
  if (!id || !channel) {
    return null;
  }
  const aliases: string[] = [];
  if (Array.isArray(channel.aliases)) {
    for (const alias of channel.aliases) {
      const normalized = normalizeOptionalLowercaseString(alias);
      if (normalized) {
        aliases.push(normalized);
      }
    }
  }
  const order =
    typeof channel.order === "number" && Number.isFinite(channel.order)
      ? channel.order
      : Number.MAX_SAFE_INTEGER;
  return {
    id,
    channel,
    aliases,
    order,
  };
}

function addBundledChannelEntries(
  entries: Map<string, BundledChannelCatalogEntry>,
  source: readonly (ChannelCatalogEntryLike | PluginPackageChannel)[],
): void {
  for (const sourceEntry of source) {
    const entry = toBundledChannelEntry(sourceEntry);
    if (entry) {
      entries.set(entry.id, entry);
    }
  }
}

export function listBundledChannelCatalogEntries(): BundledChannelCatalogEntry[] {
  const entries = new Map<string, BundledChannelCatalogEntry>();
  addBundledChannelEntries(entries, readOfficialCatalogFileSync());
  addBundledChannelEntries(entries, readBundledExtensionCatalogEntriesSync());
  return Array.from(entries.values()).toSorted(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}
