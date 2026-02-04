import type { OpenClawConfig } from "../../config/config.js";
import type { BlockStreamingCoalesceConfig } from "../../config/types.js";
import { getChannelDock } from "../../channels/dock.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  listDeliverableMessageChannels,
} from "../../utils/message-channel.js";
<<<<<<< HEAD
import { resolveTextChunkLimit, type TextChunkProvider } from "../chunk.js";
=======
import { resolveChunkMode, resolveTextChunkLimit, type TextChunkProvider } from "../chunk.js";
>>>>>>> upstream/main

const DEFAULT_BLOCK_STREAM_MIN = 800;
const DEFAULT_BLOCK_STREAM_MAX = 1200;
const DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS = 1000;
const getBlockChunkProviders = () =>
  new Set<TextChunkProvider>([...listDeliverableMessageChannels(), INTERNAL_MESSAGE_CHANNEL]);

function normalizeChunkProvider(provider?: string): TextChunkProvider | undefined {
  if (!provider) {
    return undefined;
  }
  const cleaned = provider.trim().toLowerCase();
  return getBlockChunkProviders().has(cleaned as TextChunkProvider)
    ? (cleaned as TextChunkProvider)
    : undefined;
}

type ProviderBlockStreamingConfig = {
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  accounts?: Record<string, { blockStreamingCoalesce?: BlockStreamingCoalesceConfig }>;
};

function resolveProviderBlockStreamingCoalesce(params: {
  cfg: OpenClawConfig | undefined;
  providerKey?: TextChunkProvider;
  accountId?: string | null;
}): BlockStreamingCoalesceConfig | undefined {
  const { cfg, providerKey, accountId } = params;
  if (!cfg || !providerKey) {
    return undefined;
  }
  const providerCfg = (cfg as Record<string, unknown>)[providerKey];
  if (!providerCfg || typeof providerCfg !== "object") {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const typed = providerCfg as ProviderBlockStreamingConfig;
  const accountCfg = typed.accounts?.[normalizedAccountId];
  return accountCfg?.blockStreamingCoalesce ?? typed.blockStreamingCoalesce;
}

export type BlockStreamingCoalescing = {
  minChars: number;
  maxChars: number;
  idleMs: number;
  joiner: string;
<<<<<<< HEAD
=======
  /** When true, the coalescer flushes the buffer on each enqueue (paragraph-boundary flush). */
  flushOnEnqueue?: boolean;
>>>>>>> upstream/main
};

export function resolveBlockStreamingChunking(
  cfg: OpenClawConfig | undefined,
  provider?: string,
  accountId?: string | null,
): {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
<<<<<<< HEAD
} {
  const providerKey = normalizeChunkProvider(provider);
=======
  flushOnParagraph?: boolean;
} {
  const providerKey = normalizeChunkProvider(provider);
  const providerConfigKey = providerKey;
>>>>>>> upstream/main
  const providerId = providerKey ? normalizeChannelId(providerKey) : null;
  const providerChunkLimit = providerId
    ? getChannelDock(providerId)?.outbound?.textChunkLimit
    : undefined;
<<<<<<< HEAD
  const textLimit = resolveTextChunkLimit(cfg, providerKey, accountId, {
=======
  const textLimit = resolveTextChunkLimit(cfg, providerConfigKey, accountId, {
>>>>>>> upstream/main
    fallbackLimit: providerChunkLimit,
  });
  const chunkCfg = cfg?.agents?.defaults?.blockStreamingChunk;

<<<<<<< HEAD
  // Note: chunkMode="newline" used to imply splitting on each newline, but outbound
  // delivery now treats it as paragraph-aware chunking (only split on blank lines).
  // Block streaming should follow the same rule, so we do NOT special-case newline
  // mode here.
  // (chunkMode no longer alters block streaming behavior)
=======
  // When chunkMode="newline", the outbound delivery splits on paragraph boundaries.
  // The block chunker should flush eagerly on \n\n boundaries during streaming,
  // regardless of minChars, so each paragraph is sent as its own message.
  const chunkMode = resolveChunkMode(cfg, providerConfigKey, accountId);
>>>>>>> upstream/main

  const maxRequested = Math.max(1, Math.floor(chunkCfg?.maxChars ?? DEFAULT_BLOCK_STREAM_MAX));
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minFallback = DEFAULT_BLOCK_STREAM_MIN;
  const minRequested = Math.max(1, Math.floor(chunkCfg?.minChars ?? minFallback));
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    chunkCfg?.breakPreference === "newline" || chunkCfg?.breakPreference === "sentence"
      ? chunkCfg.breakPreference
      : "paragraph";
<<<<<<< HEAD
  return { minChars, maxChars, breakPreference };
=======
  return {
    minChars,
    maxChars,
    breakPreference,
    flushOnParagraph: chunkMode === "newline",
  };
>>>>>>> upstream/main
}

export function resolveBlockStreamingCoalescing(
  cfg: OpenClawConfig | undefined,
  provider?: string,
  accountId?: string | null,
  chunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
  },
<<<<<<< HEAD
): BlockStreamingCoalescing | undefined {
  const providerKey = normalizeChunkProvider(provider);

  // Note: chunkMode="newline" is paragraph-aware in outbound delivery (blank-line splits),
  // so block streaming should not disable coalescing or flush per single newline.
=======
  opts?: { chunkMode?: "length" | "newline" },
): BlockStreamingCoalescing | undefined {
  const providerKey = normalizeChunkProvider(provider);
  const providerConfigKey = providerKey;

  // Resolve the outbound chunkMode so the coalescer can flush on paragraph boundaries
  // when chunkMode="newline", matching the delivery-time splitting behavior.
  const chunkMode = opts?.chunkMode ?? resolveChunkMode(cfg, providerConfigKey, accountId);
>>>>>>> upstream/main

  const providerId = providerKey ? normalizeChannelId(providerKey) : null;
  const providerChunkLimit = providerId
    ? getChannelDock(providerId)?.outbound?.textChunkLimit
    : undefined;
<<<<<<< HEAD
  const textLimit = resolveTextChunkLimit(cfg, providerKey, accountId, {
=======
  const textLimit = resolveTextChunkLimit(cfg, providerConfigKey, accountId, {
>>>>>>> upstream/main
    fallbackLimit: providerChunkLimit,
  });
  const providerDefaults = providerId
    ? getChannelDock(providerId)?.streaming?.blockStreamingCoalesceDefaults
    : undefined;
  const providerCfg = resolveProviderBlockStreamingCoalesce({
    cfg,
    providerKey,
    accountId,
  });
  const coalesceCfg = providerCfg ?? cfg?.agents?.defaults?.blockStreamingCoalesce;
  const minRequested = Math.max(
    1,
    Math.floor(
      coalesceCfg?.minChars ??
        providerDefaults?.minChars ??
        chunking?.minChars ??
        DEFAULT_BLOCK_STREAM_MIN,
    ),
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
  const preference = chunking?.breakPreference ?? "paragraph";
  const joiner = preference === "sentence" ? " " : preference === "newline" ? "\n" : "\n\n";
  return {
    minChars,
    maxChars,
    idleMs,
    joiner,
<<<<<<< HEAD
=======
    flushOnEnqueue: chunkMode === "newline",
>>>>>>> upstream/main
  };
}
