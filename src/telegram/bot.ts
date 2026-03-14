import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ApiClientOptions } from "grammy";
import { Bot } from "grammy";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "../auto-reply/reply/history.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "../channels/thread-bindings-policy.js";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "../config/commands.js";
import type { OpenClawConfig, ReplyToMode } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../config/group-policy.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { formatUncaughtError } from "../infra/errors.js";
import { getChildLogger } from "../logging.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveTelegramAccount } from "./accounts.js";
import { registerTelegramHandlers } from "./bot-handlers.js";
import { createTelegramMessageProcessor } from "./bot-message.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  buildTelegramUpdateKey,
  createTelegramUpdateDedupe,
  resolveTelegramUpdateId,
  type TelegramUpdateKeyContext,
} from "./bot-updates.js";
import { buildTelegramGroupPeerId, resolveTelegramStreamMode } from "./bot/helpers.js";
import { resolveTelegramTransport } from "./fetch.js";
import { tagTelegramNetworkError } from "./network-errors.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { createTelegramThreadBindingManager } from "./thread-bindings.js";

export type TelegramBotOptions = {
  token: string;
  accountId?: string;
  runtime?: RuntimeEnv;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  replyToMode?: ReplyToMode;
  proxyFetch?: typeof fetch;
  config?: OpenClawConfig;
  /** Signal to abort in-flight Telegram API fetch requests (e.g. getUpdates) on shutdown. */
  fetchAbortSignal?: AbortSignal;
  updateOffset?: {
    lastUpdateId?: number | null;
    onUpdateId?: (updateId: number) => void | Promise<void>;
  };
  testTimings?: {
    mediaGroupFlushMs?: number;
    textFragmentGapMs?: number;
  };
};

export { getTelegramSequentialKey };

type TelegramFetchInput = Parameters<NonNullable<ApiClientOptions["fetch"]>>[0];
type TelegramFetchInit = Parameters<NonNullable<ApiClientOptions["fetch"]>>[1];
type GlobalFetchInput = Parameters<typeof globalThis.fetch>[0];
type GlobalFetchInit = Parameters<typeof globalThis.fetch>[1];

function readRequestUrl(input: TelegramFetchInput): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    const url = (input as { url?: unknown }).url;
    return typeof url === "string" ? url : null;
  }
  return null;
}

function extractTelegramApiMethod(input: TelegramFetchInput): string | null {
  const url = readRequestUrl(input);
  if (!url) {
    return null;
  }
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    return segments.length > 0 ? (segments.at(-1) ?? null) : null;
  } catch {
    return null;
  }
}

export function createTelegramBot(opts: TelegramBotOptions) {
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();
  const cfg = opts.config ?? loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const threadBindingPolicy = resolveThreadBindingSpawnPolicy({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
    kind: "subagent",
  });
  const threadBindingManager = threadBindingPolicy.enabled
    ? createTelegramThreadBindingManager({
        accountId: account.accountId,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
          cfg,
          channel: "telegram",
          accountId: account.accountId,
        }),
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
          cfg,
          channel: "telegram",
          accountId: account.accountId,
        }),
      })
    : null;
  const telegramCfg = account.config;

  const telegramTransport = resolveTelegramTransport(opts.proxyFetch, {
    network: telegramCfg.network,
  });
  const shouldProvideFetch = Boolean(telegramTransport.fetch);
  // grammY's ApiClientOptions types still track `node-fetch` types; Node 22+ global fetch
  // (undici) is structurally compatible at runtime but not assignable in TS.
  const fetchForClient = telegramTransport.fetch as unknown as NonNullable<
    ApiClientOptions["fetch"]
  >;

  // When a shutdown abort signal is provided, wrap fetch so every Telegram API request
  // (especially long-polling getUpdates) aborts immediately on shutdown. Without this,
  // the in-flight getUpdates hangs for up to 30s, and a new gateway instance starting
  // its own poll triggers a 409 Conflict from Telegram.
  let finalFetch = shouldProvideFetch ? fetchForClient : undefined;
  if (opts.fetchAbortSignal) {
    const baseFetch =
      finalFetch ?? (globalThis.fetch as unknown as NonNullable<ApiClientOptions["fetch"]>);
    const shutdownSignal = opts.fetchAbortSignal;
    // Cast baseFetch to global fetch to avoid node-fetch ↔ global-fetch type divergence;
    // they are runtime-compatible (the codebase already casts at every fetch boundary).
    const callFetch = baseFetch as unknown as typeof globalThis.fetch;
    // Use manual event forwarding instead of AbortSignal.any() to avoid the cross-realm
    // AbortSignal issue in Node.js (grammY's signal may come from a different module context,
    // causing "signals[0] must be an instance of AbortSignal" errors).
    finalFetch = ((input: TelegramFetchInput, init?: TelegramFetchInit) => {
      const controller = new AbortController();
      const abortWith = (signal: AbortSignal) => controller.abort(signal.reason);
      const onShutdown = () => abortWith(shutdownSignal);
      let onRequestAbort: (() => void) | undefined;
      if (shutdownSignal.aborted) {
        abortWith(shutdownSignal);
      } else {
        shutdownSignal.addEventListener("abort", onShutdown, { once: true });
      }
      if (init?.signal) {
        if (init.signal.aborted) {
          abortWith(init.signal as unknown as AbortSignal);
        } else {
          onRequestAbort = () => abortWith(init.signal as AbortSignal);
          init.signal.addEventListener("abort", onRequestAbort);
        }
      }
      return callFetch(input as GlobalFetchInput, {
        ...(init as GlobalFetchInit),
        signal: controller.signal,
      }).finally(() => {
        shutdownSignal.removeEventListener("abort", onShutdown);
        if (init?.signal && onRequestAbort) {
          init.signal.removeEventListener("abort", onRequestAbort);
        }
      });
    }) as unknown as NonNullable<ApiClientOptions["fetch"]>;
  }
  if (finalFetch) {
    const baseFetch = finalFetch;
    finalFetch = ((input: TelegramFetchInput, init?: TelegramFetchInit) => {
      return Promise.resolve(baseFetch(input, init)).catch((err: unknown) => {
        try {
          tagTelegramNetworkError(err, {
            method: extractTelegramApiMethod(input),
            url: readRequestUrl(input),
          });
        } catch {
          // Tagging is best-effort; preserve the original fetch failure if the
          // error object cannot accept extra metadata.
        }
        throw err;
      });
    }) as unknown as NonNullable<ApiClientOptions["fetch"]>;
  }

  const timeoutSeconds =
    typeof telegramCfg?.timeoutSeconds === "number" && Number.isFinite(telegramCfg.timeoutSeconds)
      ? Math.max(1, Math.floor(telegramCfg.timeoutSeconds))
      : undefined;
  const client: ApiClientOptions | undefined =
    finalFetch || timeoutSeconds
      ? {
          ...(finalFetch ? { fetch: finalFetch } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
        }
      : undefined;

  const bot = new Bot(opts.token, client ? { client } : undefined);
  bot.api.config.use(apiThrottler());
  // Catch all errors from bot middleware to prevent unhandled rejections
  bot.catch((err) => {
    runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
  });

  const recentUpdates = createTelegramUpdateDedupe();
  const initialUpdateId =
    typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;

  // Track update_ids that have entered the middleware pipeline but have not completed yet.
  // This includes updates that are "queued" behind sequentialize(...) for a chat/topic key.
  // We only persist a watermark that is strictly less than the smallest pending update_id,
  // so we never write an offset that would skip an update still waiting to run.
  const pendingUpdateIds = new Set<number>();
  let highestCompletedUpdateId: number | null = initialUpdateId;
  let highestPersistedUpdateId: number | null = initialUpdateId;
  const maybePersistSafeWatermark = () => {
    if (typeof opts.updateOffset?.onUpdateId !== "function") {
      return;
    }
    if (highestCompletedUpdateId === null) {
      return;
    }
    let safe = highestCompletedUpdateId;
    if (pendingUpdateIds.size > 0) {
      let minPending: number | null = null;
      for (const id of pendingUpdateIds) {
        if (minPending === null || id < minPending) {
          minPending = id;
        }
      }
      if (minPending !== null) {
        safe = Math.min(safe, minPending - 1);
      }
    }
    if (highestPersistedUpdateId !== null && safe <= highestPersistedUpdateId) {
      return;
    }
    highestPersistedUpdateId = safe;
    void opts.updateOffset.onUpdateId(safe);
  };

  const shouldSkipUpdate = (ctx: TelegramUpdateKeyContext) => {
    const updateId = resolveTelegramUpdateId(ctx);
    const skipCutoff = highestPersistedUpdateId ?? initialUpdateId;
    if (typeof updateId === "number" && skipCutoff !== null && updateId <= skipCutoff) {
      return true;
    }
    const key = buildTelegramUpdateKey(ctx);
    const skipped = recentUpdates.check(key);
    if (skipped && key && shouldLogVerbose()) {
      logVerbose(`telegram dedupe: skipped ${key}`);
    }
    return skipped;
  };

  bot.use(async (ctx, next) => {
    const updateId = resolveTelegramUpdateId(ctx);
    if (typeof updateId === "number") {
      pendingUpdateIds.add(updateId);
    }
    try {
      await next();
    } finally {
      if (typeof updateId === "number") {
        pendingUpdateIds.delete(updateId);
        if (highestCompletedUpdateId === null || updateId > highestCompletedUpdateId) {
          highestCompletedUpdateId = updateId;
        }
        maybePersistSafeWatermark();
      }
    }
  });

  bot.use(sequentialize(getTelegramSequentialKey));

  const rawUpdateLogger = createSubsystemLogger("gateway/channels/telegram/raw-update");
  const MAX_RAW_UPDATE_CHARS = 8000;
  const MAX_RAW_UPDATE_STRING = 500;
  const MAX_RAW_UPDATE_ARRAY = 20;
  const stringifyUpdate = (update: unknown) => {
    const seen = new WeakSet();
    return JSON.stringify(update ?? null, (key, value) => {
      if (typeof value === "string" && value.length > MAX_RAW_UPDATE_STRING) {
        return `${value.slice(0, MAX_RAW_UPDATE_STRING)}...`;
      }
      if (Array.isArray(value) && value.length > MAX_RAW_UPDATE_ARRAY) {
        return [
          ...value.slice(0, MAX_RAW_UPDATE_ARRAY),
          `...(${value.length - MAX_RAW_UPDATE_ARRAY} more)`,
        ];
      }
      if (value && typeof value === "object") {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    });
  };

  bot.use(async (ctx, next) => {
    if (shouldLogVerbose()) {
      try {
        const raw = stringifyUpdate(ctx.update);
        const preview =
          raw.length > MAX_RAW_UPDATE_CHARS ? `${raw.slice(0, MAX_RAW_UPDATE_CHARS)}...` : raw;
        rawUpdateLogger.debug(`telegram update: ${preview}`);
      } catch (err) {
        rawUpdateLogger.debug(`telegram update log failed: ${String(err)}`);
      }
    }
    await next();
  });

  const historyLimit = Math.max(
    0,
    telegramCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const textLimit = resolveTextChunkLimit(cfg, "telegram", account.accountId);
  const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
  const allowFrom = opts.allowFrom ?? telegramCfg.allowFrom;
  const groupAllowFrom =
    opts.groupAllowFrom ?? telegramCfg.groupAllowFrom ?? telegramCfg.allowFrom ?? allowFrom;
  const replyToMode = opts.replyToMode ?? telegramCfg.replyToMode ?? "off";
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes = (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  const streamMode = resolveTelegramStreamMode(telegramCfg);
  const resolveGroupPolicy = (chatId: string | number) =>
    resolveChannelGroupPolicy({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
    });
  const resolveGroupActivation = (params: {
    chatId: string | number;
    agentId?: string;
    messageThreadId?: number;
    sessionKey?: string;
  }) => {
    const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
    const sessionKey =
      params.sessionKey ??
      `agent:${agentId}:telegram:group:${buildTelegramGroupPeerId(params.chatId, params.messageThreadId)}`;
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    try {
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      if (entry?.groupActivation === "always") {
        return false;
      }
      if (entry?.groupActivation === "mention") {
        return true;
      }
    } catch (err) {
      logVerbose(`Failed to load session for activation check: ${String(err)}`);
    }
    return undefined;
  };
  const resolveGroupRequireMention = (chatId: string | number) =>
    resolveChannelGroupRequireMention({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
      requireMentionOverride: opts.requireMention,
      overrideOrder: "after-config",
    });
  const resolveTelegramGroupConfig = (chatId: string | number, messageThreadId?: number) => {
    const groups = telegramCfg.groups;
    const direct = telegramCfg.direct;
    const chatIdStr = String(chatId);
    const isDm = !chatIdStr.startsWith("-");

    if (isDm) {
      const directConfig = direct?.[chatIdStr] ?? direct?.["*"];
      if (directConfig) {
        const topicConfig =
          messageThreadId != null ? directConfig.topics?.[String(messageThreadId)] : undefined;
        return { groupConfig: directConfig, topicConfig };
      }
      // DMs without direct config: don't fall through to groups lookup
      return { groupConfig: undefined, topicConfig: undefined };
    }

    if (!groups) {
      return { groupConfig: undefined, topicConfig: undefined };
    }
    const groupConfig = groups[chatIdStr] ?? groups["*"];
    const topicConfig =
      messageThreadId != null ? groupConfig?.topics?.[String(messageThreadId)] : undefined;
    return { groupConfig, topicConfig };
  };

  // Global sendChatAction handler with 401 backoff / circuit breaker (issue #27092).
  // Created BEFORE the message processor so it can be injected into every message context.
  // Shared across all message contexts for this account so that consecutive 401s
  // from ANY chat are tracked together — prevents infinite retry storms.
  const sendChatActionHandler = createTelegramSendChatActionHandler({
    sendChatActionFn: (chatId, action, threadParams) =>
      bot.api.sendChatAction(
        chatId,
        action,
        threadParams as Parameters<typeof bot.api.sendChatAction>[2],
      ),
    logger: (message) => logVerbose(`telegram: ${message}`),
  });

  const processMessage = createTelegramMessageProcessor({
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
  });

  registerTelegramNativeCommands({
    bot,
    cfg,
    runtime,
    accountId: account.accountId,
    telegramCfg,
    allowFrom,
    groupAllowFrom,
    replyToMode,
    textLimit,
    useAccessGroups,
    nativeEnabled,
    nativeSkillsEnabled,
    nativeDisabledExplicit,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    opts,
  });

  registerTelegramHandlers({
    cfg,
    accountId: account.accountId,
    bot,
    opts,
    telegramTransport,
    runtime,
    mediaMaxBytes,
    telegramCfg,
    allowFrom,
    groupAllowFrom,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    processMessage,
    logger,
  });

  const originalStop = bot.stop.bind(bot);
  bot.stop = ((...args: Parameters<typeof originalStop>) => {
    threadBindingManager?.stop();
    return originalStop(...args);
  }) as typeof bot.stop;

  return bot;
}
