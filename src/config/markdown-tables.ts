// Normalizes markdown table configuration by channel and rendering mode.
import { normalizeChannelId } from "../channels/plugins/index.js";
import { getLoadedChannelPlugin } from "../channels/plugins/registry.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { ResolveMarkdownTableModeParams } from "./markdown-tables.types.js";
import type { MarkdownTableMode } from "./types.base.js";

type MarkdownConfigEntry = {
  markdown?: {
    tables?: MarkdownTableMode;
  };
};

type MarkdownConfigSection = MarkdownConfigEntry & {
  accounts?: Record<string, MarkdownConfigEntry>;
};

const isMarkdownTableMode = (value: unknown): value is MarkdownTableMode =>
  value === "off" || value === "bullets" || value === "code" || value === "block";

function resolveMarkdownModeFromSection(
  section: MarkdownConfigSection | undefined,
  channel: string,
  accountId?: string | null,
): MarkdownTableMode | undefined {
  if (!section) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = section.accounts;
  if (accounts && typeof accounts === "object") {
    const match = resolveChannelAccountEntry(accounts, normalizedAccountId, channel);
    const matchMode = match?.markdown?.tables;
    if (isMarkdownTableMode(matchMode)) {
      return matchMode;
    }
  }
  const sectionMode = section.markdown?.tables;
  return isMarkdownTableMode(sectionMode) ? sectionMode : undefined;
}

export function resolveMarkdownTableMode(
  params: ResolveMarkdownTableModeParams,
): MarkdownTableMode {
  const channel = normalizeChannelId(params.channel);
  const defaultMode = channel
    ? (getLoadedChannelPlugin(channel)?.messaging?.defaultMarkdownTableMode ?? "code")
    : "code";
  let resolved = defaultMode;
  if (channel && params.cfg) {
    const channelsConfig = params.cfg.channels as Record<string, unknown> | undefined;
    const rootConfig = params.cfg as Record<string, unknown>;
    const section = (channelsConfig?.[channel] ?? rootConfig[channel]) as
      | MarkdownConfigSection
      | undefined;
    resolved = resolveMarkdownModeFromSection(section, channel, params.accountId) ?? defaultMode;
  }
  return resolved === "block" && !params.supportsBlockTables ? "code" : resolved;
}
