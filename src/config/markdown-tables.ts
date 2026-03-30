import { normalizeChannelId } from "../channels/plugins/index.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./config.js";
import type { MarkdownTableMode } from "./types.base.js";

type MarkdownConfigEntry = {
  markdown?: {
    tables?: MarkdownTableMode;
  };
};

type MarkdownConfigSection = MarkdownConfigEntry & {
  accounts?: Record<string, MarkdownConfigEntry>;
};

export const DEFAULT_TABLE_MODES = new Map<string, MarkdownTableMode>([
  ["slack", "block"],
  ["signal", "bullets"],
  ["whatsapp", "bullets"],
  ["mattermost", "off"],
]);

const isMarkdownTableMode = (value: unknown): value is MarkdownTableMode =>
  value === "off" || value === "bullets" || value === "code" || value === "block";

function resolveMarkdownModeFromSection(
  section: MarkdownConfigSection | undefined,
  accountId?: string | null,
): MarkdownTableMode | undefined {
  if (!section) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = section.accounts;
  if (accounts && typeof accounts === "object") {
    const match = resolveAccountEntry(accounts, normalizedAccountId);
    const matchMode = match?.markdown?.tables;
    if (isMarkdownTableMode(matchMode)) {
      return matchMode;
    }
  }
  const sectionMode = section.markdown?.tables;
  return isMarkdownTableMode(sectionMode) ? sectionMode : undefined;
}

/** Channels whose send path can consume extracted Block Kit table metadata. */
const BLOCK_TABLE_CHANNELS = new Set(["slack"]);

export function resolveMarkdownTableMode(params: {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
}): MarkdownTableMode {
  const channel = normalizeChannelId(params.channel);
  const defaultMode = channel ? (DEFAULT_TABLE_MODES.get(channel) ?? "code") : "code";
  if (!channel || !params.cfg) {
    return defaultMode;
  }
  const channelsConfig = params.cfg.channels as Record<string, unknown> | undefined;
  const section = (channelsConfig?.[channel] ??
    (params.cfg as Record<string, unknown> | undefined)?.[channel]) as
    | MarkdownConfigSection
    | undefined;
  const resolved = resolveMarkdownModeFromSection(section, params.accountId) ?? defaultMode;
  // Coerce "block" to "code" for channels that don't support Block Kit tables.
  // Without this, table content is silently removed because the channel's
  // send path doesn't consume the extracted table metadata.
  if (resolved === "block" && !BLOCK_TABLE_CHANNELS.has(channel)) {
    return "code";
  }
  return resolved;
}
