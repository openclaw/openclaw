import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { getChannelDock } from "../channels/dock.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";

const DEFAULT_DISCORD_DRAFT_STREAM_MIN = 200;
const DEFAULT_DISCORD_DRAFT_STREAM_MAX = 800;

export function resolveDiscordDraftStreamingChunking(
  cfg: OpenClawConfig | undefined,
  accountId?: string | null,
): {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
} {
  const providerChunkLimit = getChannelDock("discord")?.outbound?.textChunkLimit;
  const textLimit = resolveTextChunkLimit(cfg, "discord", accountId, {
    fallbackLimit: providerChunkLimit,
  });
  const normalizedAccountId = normalizeAccountId(accountId);
  const accountCfg = resolveAccountEntry(cfg?.channels?.discord?.accounts, normalizedAccountId);
  const draftCfg = accountCfg?.draftChunk ?? cfg?.channels?.discord?.draftChunk;

  const maxRequested = Math.max(
    1,
    Math.floor(draftCfg?.maxChars ?? DEFAULT_DISCORD_DRAFT_STREAM_MAX),
  );
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minRequested = Math.max(
    1,
    Math.floor(draftCfg?.minChars ?? DEFAULT_DISCORD_DRAFT_STREAM_MIN),
  );
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    draftCfg?.breakPreference === "newline" || draftCfg?.breakPreference === "sentence"
      ? draftCfg.breakPreference
      : "paragraph";
  return { minChars, maxChars, breakPreference };
}
