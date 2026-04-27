import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { resolveChannelStreamingBlockCoalesce } from "../../plugin-sdk/channel-streaming.js";
import { resolveAccountEntry } from "../../routing/account-lookup.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveChunkMode, resolveTextChunkLimit } from "../chunk.js";
const DEFAULT_BLOCK_STREAM_MIN = 800;
const DEFAULT_BLOCK_STREAM_MAX = 1200;
const DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS = 1000;
function resolveProviderChunkContext(cfg, provider, accountId) {
    const providerKey = provider
        ? normalizeMessageChannel(provider)
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
function resolveProviderBlockStreamingCoalesce(params) {
    const { cfg, providerKey, accountId } = params;
    if (!cfg || !providerKey) {
        return undefined;
    }
    const providerCfg = cfg[providerKey];
    if (!providerCfg || typeof providerCfg !== "object") {
        return undefined;
    }
    const normalizedAccountId = normalizeAccountId(accountId);
    const typed = providerCfg;
    const accountCfg = resolveAccountEntry(typed.accounts, normalizedAccountId);
    return (resolveChannelStreamingBlockCoalesce(accountCfg) ??
        resolveChannelStreamingBlockCoalesce(typed) ??
        accountCfg?.blockStreamingCoalesce ??
        typed.blockStreamingCoalesce);
}
export function clampPositiveInteger(value, fallback, bounds) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    const rounded = Math.round(value);
    if (rounded < bounds.min) {
        return bounds.min;
    }
    if (rounded > bounds.max) {
        return bounds.max;
    }
    return rounded;
}
export function resolveEffectiveBlockStreamingConfig(params) {
    const { textLimit } = resolveProviderChunkContext(params.cfg, params.provider, params.accountId);
    const chunkingDefaults = params.chunking ?? resolveBlockStreamingChunking(params.cfg, params.provider, params.accountId);
    const chunkingMax = clampPositiveInteger(params.maxChunkChars, chunkingDefaults.maxChars, {
        min: 1,
        max: Math.max(1, textLimit),
    });
    const chunking = {
        ...chunkingDefaults,
        minChars: Math.min(chunkingDefaults.minChars, chunkingMax),
        maxChars: chunkingMax,
    };
    const coalescingDefaults = resolveBlockStreamingCoalescing(params.cfg, params.provider, params.accountId, chunking);
    const coalescingMax = Math.max(1, Math.min(coalescingDefaults?.maxChars ?? chunking.maxChars, chunking.maxChars));
    const coalescingMin = Math.min(coalescingDefaults?.minChars ?? chunking.minChars, coalescingMax);
    const coalescingIdleMs = clampPositiveInteger(params.coalesceIdleMs, coalescingDefaults?.idleMs ?? DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS, { min: 0, max: 5_000 });
    const coalescing = {
        minChars: coalescingMin,
        maxChars: coalescingMax,
        idleMs: coalescingIdleMs,
        joiner: coalescingDefaults?.joiner ??
            (chunking.breakPreference === "sentence"
                ? " "
                : chunking.breakPreference === "newline"
                    ? "\n"
                    : "\n\n"),
        ...(coalescingDefaults?.flushOnEnqueue === true ? { flushOnEnqueue: true } : {}),
    };
    return { chunking, coalescing };
}
export function resolveBlockStreamingChunking(cfg, provider, accountId) {
    const { providerKey, textLimit } = resolveProviderChunkContext(cfg, provider, accountId);
    const chunkCfg = cfg?.agents?.defaults?.blockStreamingChunk;
    // When chunkMode="newline", outbound delivery prefers paragraph boundaries.
    // Keep the chunker paragraph-aware during streaming, but still let minChars
    // control when a buffered paragraph is ready to flush.
    const chunkMode = resolveChunkMode(cfg, providerKey, accountId);
    const maxRequested = Math.max(1, Math.floor(chunkCfg?.maxChars ?? DEFAULT_BLOCK_STREAM_MAX));
    const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
    const minFallback = DEFAULT_BLOCK_STREAM_MIN;
    const minRequested = Math.max(1, Math.floor(chunkCfg?.minChars ?? minFallback));
    const minChars = Math.min(minRequested, maxChars);
    const breakPreference = chunkCfg?.breakPreference === "newline" || chunkCfg?.breakPreference === "sentence"
        ? chunkCfg.breakPreference
        : "paragraph";
    return {
        minChars,
        maxChars,
        breakPreference,
        flushOnParagraph: chunkMode === "newline",
    };
}
export function resolveBlockStreamingCoalescing(cfg, provider, accountId, chunking) {
    const { providerKey, providerId, textLimit } = resolveProviderChunkContext(cfg, provider, accountId);
    const providerDefaults = providerId
        ? getChannelPlugin(providerId)?.streaming?.blockStreamingCoalesceDefaults
        : undefined;
    const providerCfg = resolveProviderBlockStreamingCoalesce({
        cfg,
        providerKey,
        accountId,
    });
    const coalesceCfg = providerCfg ?? cfg?.agents?.defaults?.blockStreamingCoalesce;
    const minRequested = Math.max(1, Math.floor(coalesceCfg?.minChars ??
        providerDefaults?.minChars ??
        chunking?.minChars ??
        DEFAULT_BLOCK_STREAM_MIN));
    const maxRequested = Math.max(1, Math.floor(coalesceCfg?.maxChars ?? textLimit));
    const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
    const minChars = Math.min(minRequested, maxChars);
    const idleMs = Math.max(0, Math.floor(coalesceCfg?.idleMs ?? providerDefaults?.idleMs ?? DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS));
    const preference = chunking?.breakPreference ?? "paragraph";
    const joiner = preference === "sentence" ? " " : preference === "newline" ? "\n" : "\n\n";
    return {
        minChars,
        maxChars,
        idleMs,
        joiner,
    };
}
