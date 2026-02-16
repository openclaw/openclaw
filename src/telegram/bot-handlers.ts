import type { Message } from "@grammyjs/types";
import type { TelegramGroupConfig, TelegramTopicConfig } from "../config/types.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
import { buildCommandsPaginationKeyboard } from "../auto-reply/reply/commands-info.js";
import { buildModelsProviderData } from "../auto-reply/reply/commands-models.js";
import { resolveStoredModelOverride } from "../auto-reply/reply/model-selection.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import { buildCommandsMessagePaginated } from "../auto-reply/status.js";
import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";
import { loadConfig } from "../config/config.js";
import { writeConfigFile } from "../config/io.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { danger, logVerbose, warn } from "../globals.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  isSenderAllowed,
  normalizeAllowFromWithStore,
  type NormalizedAllowFrom,
} from "./bot-access.js";
import { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import { MEDIA_GROUP_TIMEOUT_MS, type MediaGroupEntry } from "./bot-updates.js";
import { resolveMedia } from "./bot/delivery.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramForumThreadId,
  resolveTelegramGroupAllowFromContext,
} from "./bot/helpers.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  type ProviderInfo,
} from "./model-buttons.js";
import { buildInlineKeyboard } from "./send.js";

export const registerTelegramHandlers = ({
  cfg,
  accountId,
  bot,
  opts,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  groupAllowFrom,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  processMessage,
  logger,
}: RegisterTelegramHandlerParams) => {
  const DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
  const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4000;
  const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS =
    typeof opts.testTimings?.textFragmentGapMs === "number" &&
    Number.isFinite(opts.testTimings.textFragmentGapMs)
      ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs))
      : DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS;
  const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
  const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
  const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 50_000;
  const mediaGroupTimeoutMs =
    typeof opts.testTimings?.mediaGroupFlushMs === "number" &&
    Number.isFinite(opts.testTimings.mediaGroupFlushMs)
      ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs))
      : MEDIA_GROUP_TIMEOUT_MS;

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();
  let mediaGroupProcessing: Promise<void> = Promise.resolve();

  type TextFragmentEntry = {
    key: string;
    messages: Array<{ msg: Message; ctx: TelegramContext; receivedAtMs: number }>;
    timer: ReturnType<typeof setTimeout>;
  };
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  let textFragmentProcessing: Promise<void> = Promise.resolve();

  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  type TelegramDebounceEntry = {
    ctx: TelegramContext;
    msg: Message;
    allMedia: TelegramMediaRef[];
    storeAllowFrom: string[];
    debounceKey: string | null;
    botUsername?: string;
  };
  const buildSyntheticTextMessage = (params: {
    base: Message;
    text: string;
    date?: number;
    from?: Message["from"];
  }): Message => ({
    ...params.base,
    ...(params.from ? { from: params.from } : {}),
    text: params.text,
    caption: undefined,
    caption_entities: undefined,
    entities: undefined,
    ...(params.date != null ? { date: params.date } : {}),
  });
  const buildSyntheticContext = (
    ctx: Pick<TelegramContext, "me"> & { getFile?: unknown },
    message: Message,
  ): TelegramContext => {
    const getFile =
      typeof ctx.getFile === "function"
        ? (ctx.getFile as TelegramContext["getFile"]).bind(ctx as object)
        : async () => ({});
    return { message, me: ctx.me, getFile };
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: (entry) => {
      if (entry.allMedia.length > 0) {
        return false;
      }
      const text = entry.msg.text ?? entry.msg.caption ?? "";
      if (!text.trim()) {
        return false;
      }
      return !hasControlCommand(text, cfg, { botUsername: entry.botUsername });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await processMessage(last.ctx, last.allMedia, last.storeAllowFrom);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.msg.text ?? entry.msg.caption ?? "")
        .filter(Boolean)
        .join("\n");
      if (!combinedText.trim()) {
        return;
      }
      const first = entries[0];
      const baseCtx = first.ctx;
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });
      const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : undefined;
      await processMessage(
        buildSyntheticContext(baseCtx, syntheticMessage),
        [],
        first.storeAllowFrom,
        messageIdOverride ? { messageIdOverride } : undefined,
      );
    },
    onError: (err) => {
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
    },
  });

  const resolveTelegramSessionModel = (params: {
    chatId: number | string;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    resolvedThreadId?: number;
  }): string | undefined => {
    const resolvedThreadId =
      params.resolvedThreadId ??
      resolveTelegramForumThreadId({
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
      });
    const peerId = params.isGroup
      ? buildTelegramGroupPeerId(params.chatId, resolvedThreadId)
      : String(params.chatId);
    const parentPeer = buildTelegramParentPeer({
      isGroup: params.isGroup,
      resolvedThreadId,
      chatId: params.chatId,
    });
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId,
      peer: {
        kind: params.isGroup ? "group" : "direct",
        id: peerId,
      },
      parentPeer,
    });
    const baseSessionKey = route.sessionKey;
    const dmThreadId = !params.isGroup ? params.messageThreadId : undefined;
    const threadKeys =
      dmThreadId != null
        ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
        : null;
    const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
    const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    const storedOverride = resolveStoredModelOverride({
      sessionEntry: entry,
      sessionStore: store,
      sessionKey,
    });
    if (storedOverride) {
      return storedOverride.provider
        ? `${storedOverride.provider}/${storedOverride.model}`
        : storedOverride.model;
    }
    const provider = entry?.modelProvider?.trim();
    const model = entry?.model?.trim();
    if (provider && model) {
      return `${provider}/${model}`;
    }
    const modelCfg = cfg.agents?.defaults?.model;
    return typeof modelCfg === "string" ? modelCfg : modelCfg?.primary;
  };

  const processMediaGroup = async (entry: MediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];

      const allMedia: TelegramMediaRef[] = [];
      for (const { ctx } of entry.messages) {
        const media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          });
        }
      }

      const storeAllowFrom = await loadStoreAllowFrom();
      await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom);
    } catch (err) {
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        return;
      }

      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      if (!combinedText.trim()) {
        return;
      }

      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });

      const storeAllowFrom = await loadStoreAllowFrom();
      const baseCtx = first.ctx;

      await processMessage(buildSyntheticContext(baseCtx, syntheticMessage), [], storeAllowFrom, {
        messageIdOverride: String(last.msg.message_id),
      });
    } catch (err) {
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };

  const queueTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentProcessing = textFragmentProcessing
      .then(async () => {
        await flushTextFragments(entry);
      })
      .catch(() => undefined);
    await textFragmentProcessing;
  };

  const runTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentBuffer.delete(entry.key);
    await queueTextFragmentFlush(entry);
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      await runTextFragmentFlush(entry);
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };

  const enqueueMediaGroupFlush = async (mediaGroupId: string, entry: MediaGroupEntry) => {
    mediaGroupBuffer.delete(mediaGroupId);
    mediaGroupProcessing = mediaGroupProcessing
      .then(async () => {
        await processMediaGroup(entry);
      })
      .catch(() => undefined);
    await mediaGroupProcessing;
  };

  const scheduleMediaGroupFlush = (mediaGroupId: string, entry: MediaGroupEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      await enqueueMediaGroupFlush(mediaGroupId, entry);
    }, mediaGroupTimeoutMs);
  };

  const getOrCreateMediaGroupEntry = (mediaGroupId: string) => {
    const existing = mediaGroupBuffer.get(mediaGroupId);
    if (existing) {
      return existing;
    }
    const entry: MediaGroupEntry = {
      messages: [],
      timer: setTimeout(() => undefined, mediaGroupTimeoutMs),
    };
    mediaGroupBuffer.set(mediaGroupId, entry);
    return entry;
  };

  const loadStoreAllowFrom = async () =>
    readChannelAllowFromStore("telegram", process.env, accountId).catch(() => []);

  const isAllowlistAuthorized = (
    allow: NormalizedAllowFrom,
    senderId: string,
    senderUsername: string,
  ) =>
    allow.hasWildcard ||
    (allow.hasEntries &&
      isSenderAllowed({
        allow,
        senderId,
        senderUsername,
      }));

  const shouldSkipGroupMessage = (params: {
    isGroup: boolean;
    chatId: string | number;
    chatTitle?: string;
    resolvedThreadId?: number;
    senderId: string;
    senderUsername: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    hasGroupAllowOverride: boolean;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
  }) => {
    const {
      isGroup,
      chatId,
      chatTitle,
      resolvedThreadId,
      senderId,
      senderUsername,
      effectiveGroupAllow,
      hasGroupAllowOverride,
      groupConfig,
      topicConfig,
    } = params;
    const baseAccess = evaluateTelegramGroupBaseAccess({
      isGroup,
      groupConfig,
      topicConfig,
      hasGroupAllowOverride,
      effectiveGroupAllow,
      senderId,
      senderUsername,
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    });
    if (!baseAccess.allowed) {
      if (baseAccess.reason === "group-disabled") {
        logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
        return true;
      }
      if (baseAccess.reason === "topic-disabled") {
        logVerbose(
          `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
        );
        return true;
      }
      logVerbose(
        `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`,
      );
      return true;
    }
    if (!isGroup) {
      return false;
    }
    const policyAccess = evaluateTelegramGroupPolicyAccess({
      isGroup,
      chatId,
      cfg,
      telegramCfg,
      topicConfig,
      groupConfig,
      effectiveGroupAllow,
      senderId,
      senderUsername,
      resolveGroupPolicy,
      enforcePolicy: true,
      useTopicAndGroupOverrides: true,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });
    if (!policyAccess.allowed) {
      if (policyAccess.reason === "group-policy-disabled") {
        logVerbose("Blocked telegram group message (groupPolicy: disabled)");
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-no-sender") {
        logVerbose("Blocked telegram group message (no sender ID, groupPolicy: allowlist)");
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-empty") {
        logVerbose(
          "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
        );
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-unauthorized") {
        logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
        return true;
      }
      logger.info({ chatId, title: chatTitle, reason: "not-allowed" }, "skipping group message");
      return true;
    }
    return false;
  };

  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    if (shouldSkipUpdate(ctx)) {
      return;
    }
    const answerCallbackQuery =
      typeof (ctx as { answerCallbackQuery?: unknown }).answerCallbackQuery === "function"
        ? () => ctx.answerCallbackQuery()
        : () => bot.api.answerCallbackQuery(callback.id);
    // Answer immediately to prevent Telegram from retrying while we process
    await withTelegramApiErrorLogging({
      operation: "answerCallbackQuery",
      runtime,
      fn: answerCallbackQuery,
    }).catch(() => {});
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }
      const editCallbackMessage = async (
        text: string,
        params?: Parameters<typeof bot.api.editMessageText>[3],
      ) => {
        const editTextFn = (ctx as { editMessageText?: unknown }).editMessageText;
        if (typeof editTextFn === "function") {
          return await ctx.editMessageText(text, params);
        }
        return await bot.api.editMessageText(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          text,
          params,
        );
      };
      const deleteCallbackMessage = async () => {
        const deleteFn = (ctx as { deleteMessage?: unknown }).deleteMessage;
        if (typeof deleteFn === "function") {
          return await ctx.deleteMessage();
        }
        return await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
      };
      const replyToCallbackChat = async (
        text: string,
        params?: Parameters<typeof bot.api.sendMessage>[2],
      ) => {
        const replyFn = (ctx as { reply?: unknown }).reply;
        if (typeof replyFn === "function") {
          return await ctx.reply(text, params);
        }
        return await bot.api.sendMessage(callbackMessage.chat.id, text, params);
      };

      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId,
      });
      if (inlineButtonsScope === "off") {
        return;
      }

      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      if (inlineButtonsScope === "dm" && isGroup) {
        return;
      }
      if (inlineButtonsScope === "group" && !isGroup) {
        return;
      }

      const messageThreadId = callbackMessage.message_thread_id;
      const isForum = callbackMessage.chat.is_forum === true;
      const groupAllowContext = await resolveTelegramGroupAllowFromContext({
        chatId,
        accountId,
        isForum,
        messageThreadId,
        groupAllowFrom,
        resolveTelegramGroupConfig,
      });
      const {
        resolvedThreadId,
        storeAllowFrom,
        groupConfig,
        topicConfig,
        effectiveGroupAllow,
        hasGroupAllowOverride,
      } = groupAllowContext;
      const effectiveDmAllow = normalizeAllowFromWithStore({
        allowFrom: telegramCfg.allowFrom,
        storeAllowFrom,
      });
      const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";
      if (
        shouldSkipGroupMessage({
          isGroup,
          chatId,
          chatTitle: callbackMessage.chat.title,
          resolvedThreadId,
          senderId,
          senderUsername,
          effectiveGroupAllow,
          hasGroupAllowOverride,
          groupConfig,
          topicConfig,
        })
      ) {
        return;
      }

      if (inlineButtonsScope === "allowlist") {
        if (!isGroup) {
          if (dmPolicy === "disabled") {
            return;
          }
          if (dmPolicy !== "open") {
            const allowed = isAllowlistAuthorized(effectiveDmAllow, senderId, senderUsername);
            if (!allowed) {
              return;
            }
          }
        } else {
          const allowed = isAllowlistAuthorized(effectiveGroupAllow, senderId, senderUsername);
          if (!allowed) {
            return;
          }
        }
      }

      const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
      if (paginationMatch) {
        const pageValue = paginationMatch[1];
        if (pageValue === "noop") {
          return;
        }

        const page = Number.parseInt(pageValue, 10);
        if (Number.isNaN(page) || page < 1) {
          return;
        }

        const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(cfg) || undefined;
        const skillCommands = listSkillCommandsForAgents({
          cfg,
          agentIds: agentId ? [agentId] : undefined,
        });
        const result = buildCommandsMessagePaginated(cfg, skillCommands, {
          page,
          surface: "telegram",
        });

        const keyboard =
          result.totalPages > 1
            ? buildInlineKeyboard(
                buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId),
              )
            : undefined;

        try {
          await editCallbackMessage(result.text, keyboard ? { reply_markup: keyboard } : undefined);
        } catch (editErr) {
          const errStr = String(editErr);
          if (!errStr.includes("message is not modified")) {
            throw editErr;
          }
        }
        return;
      }

      // Model selection callback handler (mdl_prov, mdl_list_*, mdl_sel_*, mdl_back)
      const modelCallback = parseModelCallbackData(data);
      if (modelCallback) {
        const modelData = await buildModelsProviderData(cfg);
        const { byProvider, providers } = modelData;

        const editMessageWithButtons = async (
          text: string,
          buttons: ReturnType<typeof buildProviderKeyboard>,
        ) => {
          const keyboard = buildInlineKeyboard(buttons);
          try {
            await editCallbackMessage(text, keyboard ? { reply_markup: keyboard } : undefined);
          } catch (editErr) {
            const errStr = String(editErr);
            if (errStr.includes("no text in the message")) {
              try {
                await deleteCallbackMessage();
              } catch {}
              await replyToCallbackChat(text, keyboard ? { reply_markup: keyboard } : undefined);
            } else if (!errStr.includes("message is not modified")) {
              throw editErr;
            }
          }
        };

        if (modelCallback.type === "providers" || modelCallback.type === "back") {
          if (providers.length === 0) {
            await editMessageWithButtons("No providers available.", []);
            return;
          }
          const providerInfos: ProviderInfo[] = providers.map((p) => ({
            id: p,
            count: byProvider.get(p)?.size ?? 0,
          }));
          const buttons = buildProviderKeyboard(providerInfos);
          await editMessageWithButtons("Select a provider:", buttons);
          return;
        }

        if (modelCallback.type === "list") {
          const { provider, page } = modelCallback;
          const modelSet = byProvider.get(provider);
          if (!modelSet || modelSet.size === 0) {
            // Provider not found or no models - show providers list
            const providerInfos: ProviderInfo[] = providers.map((p) => ({
              id: p,
              count: byProvider.get(p)?.size ?? 0,
            }));
            const buttons = buildProviderKeyboard(providerInfos);
            await editMessageWithButtons(
              `Unknown provider: ${provider}\n\nSelect a provider:`,
              buttons,
            );
            return;
          }
          const models = [...modelSet].toSorted();
          const pageSize = getModelsPageSize();
          const totalPages = calculateTotalPages(models.length, pageSize);
          const safePage = Math.max(1, Math.min(page, totalPages));

          // Resolve current model from session (prefer overrides)
          const currentModel = resolveTelegramSessionModel({
            chatId,
            isGroup,
            isForum,
            messageThreadId,
            resolvedThreadId,
          });

          const buttons = buildModelsKeyboard({
            provider,
            models,
            currentModel,
            currentPage: safePage,
            totalPages,
            pageSize,
          });
          const text = `Models (${provider}) — ${models.length} available`;
          await editMessageWithButtons(text, buttons);
          return;
        }

        if (modelCallback.type === "select") {
          const { provider, model } = modelCallback;
          // Process model selection as a synthetic message with /model command
          const syntheticMessage = buildSyntheticTextMessage({
            base: callbackMessage,
            from: callback.from,
            text: `/model ${provider}/${model}`,
          });
          await processMessage(buildSyntheticContext(ctx, syntheticMessage), [], storeAllowFrom, {
            forceWasMentioned: true,
            messageIdOverride: callback.id,
          });
          return;
        }

        return;
      }

      const syntheticMessage = buildSyntheticTextMessage({
        base: callbackMessage,
        from: callback.from,
        text: data,
      });
      await processMessage(buildSyntheticContext(ctx, syntheticMessage), [], storeAllowFrom, {
        forceWasMentioned: true,
        messageIdOverride: callback.id,
      });
    } catch (err) {
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
    }
  });

  // Handle group migration to supergroup (chat ID changes)
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg?.migrate_to_chat_id) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const oldChatId = String(msg.chat.id);
      const newChatId = String(msg.migrate_to_chat_id);
      const chatTitle = msg.chat.title ?? "Unknown";

      runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`));

      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
        runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
        return;
      }

      // Check if old chat ID has config and migrate it
      const currentConfig = loadConfig();
      const migration = migrateTelegramGroupConfig({
        cfg: currentConfig,
        accountId,
        oldChatId,
        newChatId,
      });

      if (migration.migrated) {
        runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
        migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
        await writeConfigFile(currentConfig);
        runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
      } else if (migration.skippedExisting) {
        runtime.log?.(
          warn(
            `[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`,
          ),
        );
      } else {
        runtime.log?.(
          warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`),
        );
      }
    } catch (err) {
      runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
    }
  });

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const chatId = msg.chat.id;
      const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
      const messageThreadId = msg.message_thread_id;
      const isForum = msg.chat.is_forum === true;
      const groupAllowContext = await resolveTelegramGroupAllowFromContext({
        chatId,
        accountId,
        isForum,
        messageThreadId,
        groupAllowFrom,
        resolveTelegramGroupConfig,
      });
      const {
        resolvedThreadId,
        storeAllowFrom,
        groupConfig,
        topicConfig,
        effectiveGroupAllow,
        hasGroupAllowOverride,
      } = groupAllowContext;

      const senderId = msg.from?.id != null ? String(msg.from.id) : "";
      const senderUsername = msg.from?.username ?? "";
      if (
        shouldSkipGroupMessage({
          isGroup,
          chatId,
          chatTitle: msg.chat.title,
          resolvedThreadId,
          senderId,
          senderUsername,
          effectiveGroupAllow,
          hasGroupAllowOverride,
          groupConfig,
          topicConfig,
        })
      ) {
        return;
      }

      // Text fragment handling - Telegram splits long pastes into multiple inbound messages (~4096 chars).
      // We buffer “near-limit” messages and append immediately-following parts.
      const text = typeof msg.text === "string" ? msg.text : undefined;
      const isCommandLike = (text ?? "").trim().startsWith("/");
      if (text && !isCommandLike) {
        const nowMs = Date.now();
        const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
        const key = `text:${chatId}:${resolvedThreadId ?? "main"}:${senderId}`;
        const existing = textFragmentBuffer.get(key);

        if (existing) {
          const last = existing.messages.at(-1);
          const lastMsgId = last?.msg.message_id;
          const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
          const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
          const timeGapMs = nowMs - lastReceivedAtMs;
          const canAppend =
            idGap > 0 &&
            idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP &&
            timeGapMs >= 0 &&
            timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS;

          if (canAppend) {
            const currentTotalChars = existing.messages.reduce(
              (sum, m) => sum + (m.msg.text?.length ?? 0),
              0,
            );
            const nextTotalChars = currentTotalChars + text.length;
            if (
              existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS &&
              nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS
            ) {
              existing.messages.push({ msg, ctx, receivedAtMs: nowMs });
              scheduleTextFragmentFlush(existing);
              return;
            }
          }

          // Not appendable (or limits exceeded): flush buffered entry first, then continue normally.
          clearTimeout(existing.timer);
          await runTextFragmentFlush(existing);
        }

        const shouldStart = text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS;
        if (shouldStart) {
          const entry: TextFragmentEntry = {
            key,
            messages: [{ msg, ctx, receivedAtMs: nowMs }],
            timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS),
          };
          textFragmentBuffer.set(key, entry);
          scheduleTextFragmentFlush(entry);
          return;
        }
      }

      // Media group handling - buffer multi-image messages
      const mediaGroupId = msg.media_group_id;
      if (mediaGroupId) {
        const entry = getOrCreateMediaGroupEntry(mediaGroupId);
        entry.messages.push({ msg, ctx });
        scheduleMediaGroupFlush(mediaGroupId, entry);
        return;
      }

      let media: Awaited<ReturnType<typeof resolveMedia>> = null;
      try {
        media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
      } catch (mediaErr) {
        const errMsg = String(mediaErr);
        if (errMsg.includes("exceeds") && errMsg.includes("MB limit")) {
          const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, {
                reply_to_message_id: msg.message_id,
              }),
          }).catch(() => {});
          logger.warn({ chatId, error: errMsg }, "media exceeds size limit");
          return;
        }
        throw mediaErr;
      }

      // Skip sticker-only messages where the sticker was skipped (animated/video)
      // These have no media and no text content to process.
      const hasText = Boolean((msg.text ?? msg.caption ?? "").trim());
      if (msg.sticker && !media && !hasText) {
        logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
        return;
      }

      const allMedia = media
        ? [
            {
              path: media.path,
              contentType: media.contentType,
              stickerMetadata: media.stickerMetadata,
            },
          ]
        : [];
      const conversationKey =
        resolvedThreadId != null ? `${chatId}:topic:${resolvedThreadId}` : String(chatId);
      const debounceKey = senderId
        ? `telegram:${accountId ?? "default"}:${conversationKey}:${senderId}`
        : null;
      await inboundDebouncer.enqueue({
        ctx,
        msg,
        allMedia,
        storeAllowFrom,
        debounceKey,
        botUsername: ctx.me?.username,
      });
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  });
};
