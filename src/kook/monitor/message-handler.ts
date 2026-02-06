// KOOK Message Handler
// Processes incoming KOOK events and routes to agent

import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "../../auto-reply/dispatch.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { recordInboundSession } from "../../channels/session.js";
import { resolveStorePath } from "../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { buildAgentSessionKey, resolveAgentRoute } from "../../routing/resolve-route.js";
import { resolveKookAccount } from "../accounts.js";
import { sendMessageKook } from "../send.js";

export type KookMessageHandler = (event: KookEventData) => Promise<void>;

export type KookEventData = {
  channel_type: string;
  type: number;
  target_id: string;
  author_id: string;
  content: string;
  msg_id: string;
  msg_timestamp: number;
  nonce: string;
  extra: {
    type?: number;
    guild_id?: string;
    channel_name?: string;
    mention?: string[];
    mention_all?: boolean;
    mention_roles?: string[];
    mention_here?: boolean;
    author?: {
      id: string;
      username: string;
      nickname?: string;
      avatar: string;
      identify_num?: string;
      roles?: number[];
    };
    kmarkdown?: {
      raw_content: string;
      mention_part?: unknown[];
      mention_role_part?: unknown[];
    };
    attachments?: {
      type: string;
      name?: string;
      url: string;
      file_type?: string;
      size?: number;
    };
    [key: string]: unknown;
  };
};

// KOOK message types
const MESSAGE_TYPES = {
  TEXT: 1,
  IMAGE: 2,
  VIDEO: 3,
  FILE: 4,
  KMARKDOWN: 9,
  CARD: 10,
  ITEM: 12,
} as const;

type CreateHandlerParams = {
  cfg: OpenClawConfig;
  accountId: string;
  token: string;
  runtime: RuntimeEnv;
  historyLimit?: number;
  mediaMaxMb?: number;
};

/**
 * Extract message text based on type
 */
function resolveMessageContent(event: KookEventData): string {
  switch (event.type) {
    case MESSAGE_TYPES.TEXT:
      return event.content;

    case MESSAGE_TYPES.KMARKDOWN:
      return event.extra.kmarkdown?.raw_content ?? event.content;

    case MESSAGE_TYPES.IMAGE:
    case MESSAGE_TYPES.VIDEO:
    case MESSAGE_TYPES.FILE:
      return event.extra.attachments?.url ?? event.content;

    case MESSAGE_TYPES.CARD:
      // Card messages have content as JSON string
      try {
        const card = JSON.parse(event.content);
        return `[Card Message: ${JSON.stringify(card).slice(0, 100)}...]`;
      } catch {
        return event.content;
      }

    case MESSAGE_TYPES.ITEM:
      // Item/prop messages
      const itemData = event.content as unknown as {
        type?: string;
        data?: { user_id?: string; target_id?: string; item_id?: number };
      };
      return `[Item: ${itemData.data?.item_id ?? "unknown"}]`;

    default:
      return event.content;
  }
}

/**
 * Check if message is from a bot
 */
async function isBotMessage(event: KookEventData, token: string): Promise<boolean> {
  try {
    const botUserId = await getBotUserId(token);
    return event.author_id === botUserId;
  } catch (error) {
    console.error(`[KOOK-MSG] Failed to check if message is from bot: ${String(error)}`);
    return false;
  }
}

// Cache for bot user ID per token to avoid multiple API calls
const botUserIdCache = new Map<string, string>();

/**
 * Get bot user ID from API
 */
async function getBotUserId(token: string): Promise<string> {
  const cached = botUserIdCache.get(token);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch("https://www.kookapp.cn/api/v3/user/me", {
      headers: {
        Authorization: `Bot ${token}`,
      },
    });

    if (response.ok) {
      const data = await response.json();
      if (data.code === 0 && data.data?.id) {
        const botId = String(data.data.id);
        botUserIdCache.set(token, botId);
        return botId;
      }
    }
  } catch {
    // Ignore fetch errors
  }

  // Return a default value if we can't get the bot ID
  return "unknown";
}

/**
 * Create message handler for KOOK
 */
export function createKookMessageHandler(params: CreateHandlerParams): KookMessageHandler {
  const { cfg, accountId, runtime } = params;

  // Resolve account for configuration
  const account = resolveKookAccount({ cfg, accountId });

  return async (event: KookEventData) => {
    // Capture all needed variables at the start
    const currentCfg = cfg;
    const currentAccountId = accountId;
    const currentToken = params.token;

    try {
      // Skip system messages (type=255)
      if (event.type === 255) {
        return;
      }

      // Extract message content early
      const text = resolveMessageContent(event);
      const isDm = event.channel_type === "PERSON";
      const author = event.extra.author;

      // Skip bot messages
      if (await isBotMessage(event, currentToken)) {
        return;
      }

      // Check user allowlist for guild messages
      if (!isDm && event.extra.guild_id) {
        const guilds = account.config.guilds ?? {};
        const guildConfig = guilds[event.extra.guild_id];

        if (guildConfig?.users && guildConfig.users.length > 0) {
          const isAllowedUser = guildConfig.users.some(
            (userId) => String(userId) === event.author_id,
          );
          if (!isAllowedUser) {
            if (shouldLogVerbose()) {
              logVerbose(`[kook] ignoring message from non-allowed user: ${event.author_id}`);
            }
            return;
          }
        }
      }

      if (shouldLogVerbose()) {
        logVerbose(
          `[kook] message from ${author?.username ?? event.author_id}: ${text.slice(0, 50)}`,
        );
      }

      // Check allowlist for DMs with full pairing support
      if (isDm) {
        const dmPolicy = account.config.dm?.policy ?? "pairing";
        const configuredAllowFrom = account.config.dm?.allowFrom ?? [];

        // Read pairing store allowlist
        const storeAllowFrom = await readChannelAllowFromStore("kook").catch(() => []);
        const combinedAllowFrom = Array.from(new Set([...configuredAllowFrom, ...storeAllowFrom]));

        // Handle disabled policy
        if ((dmPolicy as string) === "disabled") {
          if (shouldLogVerbose()) {
            logVerbose(`[kook] ignoring DM (dmPolicy: disabled)`);
          }
          return;
        }

        // Handle open policy (allow all)
        if (dmPolicy !== "open") {
          // Handle allowlist and pairing policies
          const isAllowed = combinedAllowFrom.some((entry) => String(entry) === event.author_id);

          if (!isAllowed) {
            if (dmPolicy === "pairing") {
              // Create pairing request and send code
              const { code, created } = await upsertChannelPairingRequest({
                channel: "kook",
                id: event.author_id,
                meta: { name: author?.username ?? event.author_id },
              });

              // Only send pairing code if it's a new request (avoid spam)
              if (code && created) {
                try {
                  await sendMessageKook(
                    `user:${event.author_id}`,
                    buildPairingReply({
                      channel: "kook",
                      idLine: `Your KOOK user ID: ${event.author_id}`,
                      code,
                    }),
                    { accountId: currentAccountId },
                    currentCfg,
                  );
                } catch {
                  // Ignore pairing reply errors
                }
              }
            }

            if (shouldLogVerbose()) {
              logVerbose(`[kook] ignoring DM from non-allowed user: ${event.author_id}`);
            }
            return;
          }
        }
      }

      // Check group policy for channel messages
      if (!isDm && event.extra.guild_id) {
        const groupPolicy = account.config.groupPolicy ?? "disabled";

        if (groupPolicy === "disabled") {
          if (shouldLogVerbose()) {
            logVerbose(
              `[kook] ignoring group message (groupPolicy=disabled): ${event.extra.guild_id}`,
            );
          }
          return;
        }

        if (groupPolicy === "allowlist") {
          const guilds = account.config.guilds ?? {};
          const guildConfig = guilds[event.extra.guild_id];

          if (!guildConfig) {
            if (shouldLogVerbose()) {
              logVerbose(
                `[kook] ignoring group message from non-allowed guild: ${event.extra.guild_id}`,
              );
            }
            return;
          }

          // Check if channel is allowed
          const channelId = event.target_id;
          const channelConfig = guildConfig.channels?.[channelId];

          if (!channelConfig || !channelConfig.allow) {
            if (shouldLogVerbose()) {
              logVerbose(`[kook] ignoring message from non-allowed channel: ${channelId}`);
            }
            return;
          }
        }
      }

      // Build MsgContext for agent dispatch
      const isGuildMessage = !isDm && event.extra.guild_id;

      // Resolve agent route
      const route = resolveAgentRoute({
        cfg: currentCfg,
        channel: "kook",
        accountId: currentAccountId,
        peer: isDm ? { kind: "dm", id: event.author_id } : { kind: "channel", id: event.target_id },
        guildId: event.extra.guild_id ?? null,
      });

      // Build session key
      const sessionKey = buildAgentSessionKey({
        agentId: route.agentId,
        channel: "kook",
        peer: isDm ? { kind: "dm", id: event.author_id } : { kind: "channel", id: event.target_id },
      });

      // Build From/To labels
      // CRITICAL: For sending, effectiveTo must use "user:<id>" format for DMs, "channel:<id>" for channels
      // This is required by parseTarget in send.ts
      const effectiveFrom = isDm
        ? `kook:user:${event.author_id}`
        : `kook:channel:${event.target_id}`;
      // For sending messages: use simple format without kook: prefix
      const effectiveTo = isDm ? `user:${event.author_id}` : `channel:${event.target_id}`;
      // For display/logging purposes
      const displayTo = isDm ? `kook:user:${event.author_id}` : `kook:channel:${event.target_id}`;

      console.log(`[KOOK-MSG] Routing: effectiveFrom=${effectiveFrom}, effectiveTo=${effectiveTo}`);
      console.log(
        `[KOOK-MSG] Target details: isDm=${isDm}, author_id=${event.author_id}, target_id=${event.target_id}`,
      );

      // Check if channel requires mention
      let requiresMention = true;
      if (!isDm && event.extra.guild_id) {
        const guilds = account.config.guilds ?? {};
        const guildConfig = guilds[event.extra.guild_id];
        if (guildConfig) {
          const channelId = event.target_id;
          const channelConfig = guildConfig.channels?.[channelId];
          if (channelConfig && typeof channelConfig.requireMention === "boolean") {
            requiresMention = channelConfig.requireMention;
          } else if (typeof guildConfig.requireMention === "boolean") {
            requiresMention = guildConfig.requireMention;
          }
        }
      }

      // Check if message mentions the bot (only if needed)
      let mentionsBot = false;
      let botUserId: string | null = null;
      if (requiresMention || event.extra.mention?.length) {
        try {
          botUserId = await getBotUserId(params.token);
          console.log(`[KOOK-MSG] Bot user ID: ${botUserId}`);
          mentionsBot = event.extra.mention?.includes(botUserId) || false;
          console.log(`[KOOK-MSG] Mention list: ${JSON.stringify(event.extra.mention)}`);
        } catch (error) {
          console.error(`[KOOK-MSG] Failed to check bot mention: ${String(error)}`);
          // If we can't check bot mention and channel requires mention, skip the message
          if (requiresMention) {
            console.log(`[KOOK-MSG] Skipping message due to bot mention check failure`);
            return;
          }
        }
      }

      const mentionAll = event.extra.mention_all || false;

      console.log(
        `[KOOK-MSG] Mention check: mentionsBot=${mentionsBot}, mentionAll=${mentionAll}, isDm=${isDm}, requiresMention=${requiresMention}`,
      );

      // Only process if it's a DM or if mentions are configured
      if (!isDm && requiresMention && !mentionsBot && !mentionAll) {
        console.log(
          `[KOOK-MSG] Skipping channel message without mention (channel requires mention)`,
        );
        console.log(
          `[KOOK-MSG] Message details: guild=${event.extra.guild_id}, channel=${event.target_id}, mentions=${JSON.stringify(event.extra.mention)}`,
        );
        if (shouldLogVerbose()) {
          logVerbose(`[kook] ignoring message without mention in channel ${event.target_id}`);
        }
        return;
      }

      console.log(`[KOOK-MSG] Message will be processed`);

      console.log(`[KOOK-MSG] Message will be processed`);

      // Build MsgContext
      console.log(`[KOOK-MSG] Building MsgContext...`);
      const ctxPayload: MsgContext = {
        Body: text,
        RawBody: text,
        CommandBody: text,
        From: effectiveFrom,
        To: displayTo, // Use displayTo for logging/display
        SessionKey: sessionKey,
        AccountId: currentAccountId,
        ChatType: isDm ? "direct" : "channel",
        ConversationLabel: isDm
          ? author?.nickname || author?.username || event.author_id
          : event.extra.channel_name || `Channel ${event.target_id}`,
        SenderName: author?.nickname || author?.username,
        SenderId: event.author_id,
        SenderUsername: author?.username,
        GroupSubject: !isDm ? event.extra.channel_name || `Channel ${event.target_id}` : undefined,
        GroupChannel: !isDm ? `#${event.extra.channel_name || event.target_id}` : undefined,
        GroupSpace: isGuildMessage ? event.extra.guild_id : undefined,
        Provider: "kook" as const,
        Surface: "kook" as const,
        WasMentioned: mentionsBot || mentionAll,
        MessageSid: event.msg_id,
        Timestamp: event.msg_timestamp,
        CommandAuthorized: true, // TODO: Implement proper authorization check
        CommandSource: "text" as const,
        OriginatingChannel: "kook" as const,
        OriginatingTo: displayTo, // Use displayTo for logging/display
      };

      console.log(
        `[KOOK-MSG] Built MsgContext: SessionKey=${sessionKey}, ChatType=${ctxPayload.ChatType}`,
      );

      // Finalize context
      const finalizedCtx = finalizeInboundContext(ctxPayload);

      // Record inbound session
      const storePath = resolveStorePath(currentCfg.session?.store, {
        agentId: route.agentId,
      });
      await recordInboundSession({
        storePath,
        sessionKey,
        ctx: finalizedCtx,
        updateLastRoute: isDm
          ? {
              sessionKey: route.mainSessionKey,
              channel: "kook",
              to: `user:${event.author_id}`,
              accountId: currentAccountId,
            }
          : undefined,
        onRecordError: (err) => {
          runtime.error?.(`[kook] failed updating session meta: ${String(err)}`);
        },
      });

      // Create reply dispatcher
      const { replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
        deliver: async (payload) => {
          console.log(
            `[KOOK-MSG] Dispatcher delivering: to=${effectiveTo}, text="${(payload.text || "").slice(0, 50)}..."`,
          );
          // Pass cfg directly to sendMessageKook to ensure token is available
          await sendMessageKook(
            effectiveTo,
            payload.text || "",
            {
              accountId: currentAccountId,
              // token will be resolved from config in sendMessageKook
              quote: event.msg_id,
              type: 9, // Use KMarkdown for better formatting
            },
            currentCfg,
          );
          console.log(`[KOOK-MSG] Dispatcher delivery completed`);
        },
        onReplyStart: async () => {
          console.log(`[KOOK-MSG] Reply starting to ${author?.username ?? event.author_id}`);
          if (shouldLogVerbose()) {
            logVerbose(`[kook] starting reply to ${author?.username ?? event.author_id}`);
          }
        },
        onError: (err) => {
          console.error(`[KOOK-MSG] Reply error: ${String(err)}`);
          runtime.error?.(danger(`[kook] reply error: ${String(err)}`));
        },
      });

      // Dispatch to agent
      console.log(
        `[KOOK-MSG] Dispatching to agent: agentId=${route.agentId}, sessionKey=${sessionKey}`,
      );
      if (shouldLogVerbose()) {
        logVerbose(
          `[kook] dispatching message from ${author?.username ?? event.author_id} to agent ${route.agentId}`,
        );
      }

      console.log(`[KOOK-MSG] About to call dispatchInboundMessageWithBufferedDispatcher...`);
      await dispatchInboundMessageWithBufferedDispatcher({
        ctx: finalizedCtx,
        cfg: currentCfg,
        dispatcherOptions: {
          deliver: async (payload) => {
            // Use the created dispatcher to send the message
            console.log(
              `[KOOK-MSG] Buffered dispatcher delivering: text="${(payload.text || "").slice(0, 50)}..."`,
            );
            if (payload.text) {
              // Pass cfg directly to sendMessageKook to ensure token is available
              await sendMessageKook(
                effectiveTo,
                payload.text || "",
                {
                  accountId: currentAccountId,
                  // token will be resolved from config in sendMessageKook
                  quote: event.msg_id,
                  type: 9,
                },
                currentCfg,
              );
              console.log(`[KOOK-MSG] Buffered dispatcher delivery completed`);
            }
          },
          responsePrefix: undefined,
          onReplyStart: replyOptions.onReplyStart,
          onError: (err) => {
            console.error(`[KOOK-MSG] Dispatch error: ${String(err)}`);
            runtime.error?.(danger(`[kook] dispatch error: ${String(err)}`));
          },
        },
        replyOptions: {
          onModelSelected: (ctx) => {
            console.log(`[KOOK-MSG] Model selected: ${ctx.model}`);
            if (shouldLogVerbose()) {
              logVerbose(`[kook] using model: ${ctx.model}`);
            }
          },
        },
      });

      console.log(`[KOOK-MSG] Dispatch completed successfully`);
      markDispatchIdle();
    } catch (error) {
      runtime.error?.(`[kook] message handler error: ${String(error)}`);
    }
  };
}
