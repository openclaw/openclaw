import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { resolveChannelStreamingBlockCoalesce } from "../../channels/streaming.js";
import type { BlockStreamingCoalesceConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveChannelAccountEntry } from "../../routing/account-lookup.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveChunkMode, resolveTextChunkLimit, type TextChunkProvider } from "../chunk.js";

const DEFAULT_BLOCK_STREAM_MIN = 800;
const DEFAULT_BLOCK_STREAM_MAX = 1200;
const DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS = 1000;

function resolveProviderChunkContext(
  cfg: OpenClawConfig | undefined,
  provider?: string,
  accountId?: string | null,
) {
  const providerKey = provider
    ? (normalizeMessageChannel(provider) as TextChunkProvider | undefined)
    : undefined;
  const providerId = providerKey ? normalizeChannelId(providerKey) : null;
  const providerChunkLimit = providerId
    ? getChannelPlugin(providerId)?.outbound?.textChunkLimit
    : undefined;
  const textLimit = resolveTextChunkLimit(cfg, providerKey, accountId, {
    fallbackLimit: providerChunkLimit,
  });
  return { providerKey, providerId, textLimit };
}

export type BlockStreamingCoalescing = {
  minChars: number;
  maxChars: number;
  idleMs: number;
  joiner: string;
};

type BlockStreamingChunking = {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
  flushOnParagraph?: boolean;
};

function clampPositiveInteger(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return rounded < bounds.min ? bounds.min : Math.min(rounded, bounds.max);
}

export function resolveEffectiveBlockStreamingConfig(params: {
  cfg: OpenClawConfig | undefined;
  provider?: string;
  accountId?: string | null;
  chunking?: BlockStreamingChunking;
  /** Optional upper bound for chunking/coalescing max chars. */
  maxChunkChars?: number;
  coalesceIdleMs?: number;
}) {
  const providerContext = resolveProviderChunkContext(
    params.cfg,
    params.provider,
    params.accountId,
  );
  const chunkingDefaults =
    params.chunking ?? resolveBlockStreamingChunking(params.cfg, params.provider, params.accountId);
  const chunkingMax = clampPositiveInteger(params.maxChunkChars, chunkingDefaults.maxChars, {
    min: 1,
    max: Math.max(1, providerContext.textLimit),
  });
  const chunking: BlockStreamingChunking = {
    ...chunkingDefaults,
    minChars: Math.min(chunkingDefaults.minChars, chunkingMax),
    maxChars: chunkingMax,
  };
  const cfg = params.cfg;
  const accountId = params.accountId;
  const { providerKey, providerId, textLimit } = providerContext;
  const providerDefaults = providerId
    ? getChannelPlugin(providerId)?.streaming?.blockStreamingCoalesceDefaults
    : undefined;
  let providerCfg: BlockStreamingCoalesceConfig | undefined;
  if (cfg && providerKey) {
    const channelsConfig = cfg.channels as Record<string, unknown> | undefined;
    const channelCfg = channelsConfig?.[providerKey];
    if (channelCfg && typeof channelCfg === "object") {
      const normalizedAccountId = normalizeAccountId(accountId);
      const typed = channelCfg as {
        streaming?: unknown;
        accounts?: Record<string, { streaming?: unknown }>;
      };
      const accountCfg = resolveChannelAccountEntry(
        typed.accounts,
        normalizedAccountId,
        providerKey,
      );
      const channelCoalesce = resolveChannelStreamingBlockCoalesce(typed);
      const accountCoalesce = accountCfg
        ? resolveChannelStreamingBlockCoalesce(accountCfg)
        : undefined;
      if (channelCoalesce || accountCoalesce) {
        providerCfg = { ...channelCoalesce, ...accountCoalesce };
      }
    }
  }
  const coalesceCfg = providerCfg ?? cfg?.agents?.defaults?.blockStreamingCoalesce;
  const minRequested = Math.max(
    1,
    Math.floor(coalesceCfg?.minChars ?? providerDefaults?.minChars ?? chunking.minChars),
  );
  const maxRequested = Math.max(1, Math.floor(coalesceCfg?.maxChars ?? textLimit));
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minChars = Math.min(minRequested, maxChars);
  const idleMs = Math.max(
    0,
    Math.floor(
      coalesceCfg?.idleMs ?? providerDefaults?.idleMs ?? DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS,
    ),
  );
  const preference = chunking.breakPreference;
  const joiner = preference === "sentence" ? " " : preference === "newline" ? "\n" : "\n\n";
  const coalescingMax = Math.max(1, Math.min(maxChars, chunking.maxChars));
  return {
    chunking,
    coalescing: {
      minChars: Math.min(minChars, coalescingMax),
      maxChars: coalescingMax,
      idleMs: clampPositiveInteger(params.coalesceIdleMs, idleMs, {
        min: 0,
        max: 5_000,
      }),
      joiner,
    },
  };
}

export function resolveBlockStreamingChunking(
  cfg: OpenClawConfig | undefined,
  provider?: string,
  accountId?: string | null,
): BlockStreamingChunking {
  const { providerKey, textLimit } = resolveProviderChunkContext(cfg, provider, accountId);
  const chunkCfg = cfg?.agents?.defaults?.blockStreamingChunk;

  // When chunkMode="newline", outbound delivery prefers paragraph boundaries.
  // Keep the chunker paragraph-aware during streaming, but still let minChars
  // control when a buffered paragraph is ready to flush.
  const chunkMode = resolveChunkMode(cfg, providerKey, accountId);

  const maxRequested = Math.max(1, Math.floor(chunkCfg?.maxChars ?? DEFAULT_BLOCK_STREAM_MAX));
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minRequested = Math.max(1, Math.floor(chunkCfg?.minChars ?? DEFAULT_BLOCK_STREAM_MIN));
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    chunkCfg?.breakPreference === "newline" || chunkCfg?.breakPreference === "sentence"
      ? chunkCfg.breakPreference
      : "paragraph";
  return {
    minChars,
    maxChars,
    breakPreference,
    flushOnParagraph: chunkMode === "newline",
  };
}
