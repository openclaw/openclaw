import type { MessageEvent, WebhookRequestBody } from "@line/bot-sdk";
import { chunkMarkdownText } from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { buildMentionRegexes, matchesMentionPatterns } from "../auto-reply/reply/mentions.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { resolveMentionGatingWithBypass } from "../channels/mention-gating.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelGroupRequireMention } from "../config/group-policy.js";
import { danger, logVerbose } from "../globals.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import { normalizePluginHttpPath } from "../plugins/http-path.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import type { RuntimeEnv } from "../runtime.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { createLineBot } from "./bot.js";
import { processLineMessage } from "./markdown-to-line.js";
import { sendLineReplyChunks } from "./reply-chunks.js";
import {
  replyMessageLine,
  showLoadingAnimation,
  getUserDisplayName,
  createQuickReplyItems,
  createTextMessageWithQuickReplies,
  pushTextMessageWithQuickReplies,
  pushMessageLine,
  pushMessagesLine,
  createFlexMessage,
  createImageMessage,
  createLocationMessage,
} from "./send.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineChannelData, ResolvedLineAccount } from "./types.js";
import { createLineNodeWebhookHandler } from "./webhook-node.js";

export interface MonitorLineProviderOptions {
  channelAccessToken: string;
  channelSecret: string;
  accountId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookUrl?: string;
  webhookPath?: string;
}

export interface LineProviderMonitor {
  account: ResolvedLineAccount;
  handleWebhook: (body: WebhookRequestBody) => Promise<void>;
  stop: () => void;
}

// Track runtime state in memory (simplified version)
const runtimeState = new Map<
  string,
  {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }
>();

function recordChannelRuntimeState(params: {
  channel: string;
  accountId: string;
  state: Partial<{
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
  }>;
}): void {
  const key = `${params.channel}:${params.accountId}`;
  const existing = runtimeState.get(key) ?? {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  runtimeState.set(key, { ...existing, ...params.state });
}

export function getLineRuntimeState(accountId: string) {
  return runtimeState.get(`line:${accountId}`);
}

function startLineLoadingKeepalive(params: {
  userId: string;
  accountId?: string;
  intervalMs?: number;
  loadingSeconds?: number;
}): () => void {
  const intervalMs = params.intervalMs ?? 18_000;
  const loadingSeconds = params.loadingSeconds ?? 20;
  let stopped = false;

  const trigger = () => {
    if (stopped) {
      return;
    }
    void showLoadingAnimation(params.userId, {
      accountId: params.accountId,
      loadingSeconds,
    }).catch(() => {});
  };

  trigger();
  const timer = setInterval(trigger, intervalMs);

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}

export async function monitorLineProvider(
  opts: MonitorLineProviderOptions,
): Promise<LineProviderMonitor> {
  const {
    channelAccessToken,
    channelSecret,
    accountId,
    config,
    runtime,
    abortSignal,
    webhookPath,
  } = opts;
  const resolvedAccountId = accountId ?? "default";
  const token = channelAccessToken.trim();
  const secret = channelSecret.trim();

  if (!token) {
    throw new Error("LINE webhook mode requires a non-empty channel access token.");
  }
  if (!secret) {
    throw new Error("LINE webhook mode requires a non-empty channel secret.");
  }

  // Record starting state
  recordChannelRuntimeState({
    channel: "line",
    accountId: resolvedAccountId,
    state: {
      running: true,
      lastStartAt: Date.now(),
    },
  });

  // Create the bot
  const bot = createLineBot({
    channelAccessToken: token,
    channelSecret: secret,
    accountId,
    runtime,
    config,
    onMessage: async (ctx) => {
      if (!ctx) {
        return;
      }

      const { ctxPayload, replyToken, route } = ctx;

      // ── LINE mention gating ──
      // Skip group messages when requireMention is configured and bot is not mentioned.
      // This matches the gating pattern used by WhatsApp, Telegram, Discord, Slack, and Signal.
      if (ctx.isGroup) {
        const requireMention = resolveChannelGroupRequireMention({
          cfg: config,
          channel: "line",
          groupId: ctx.groupId,
          accountId: ctx.accountId,
        });

        if (requireMention) {
          const messageText = ctxPayload.RawBody ?? ctxPayload.Body ?? "";
          const mentionRegexes = buildMentionRegexes(config, route.agentId);
          const wasMentioned = matchesMentionPatterns(messageText, mentionRegexes);

          // Also check LINE-native mention objects (message.mention.mentionees)
          const event = ctx.event as MessageEvent;
          const lineMention =
            event?.message?.type === "text" ? event.message.mention : undefined;
          const hasLineMention = Boolean(
            lineMention && lineMention.mentionees && lineMention.mentionees.length > 0,
          );

          const effectiveWasMentioned = wasMentioned || hasLineMention;
          const hasCmd = hasControlCommand(messageText, config);
          const canDetectMention = mentionRegexes.length > 0 || true; // LINE always supports native mentions

          const mentionGate = resolveMentionGatingWithBypass({
            isGroup: true,
            requireMention: true,
            canDetectMention,
            wasMentioned: effectiveWasMentioned,
            implicitMention: false,
            hasAnyMention: hasLineMention,
            allowTextCommands: true,
            hasControlCommand: hasCmd,
            commandAuthorized: false,
          });

          if (mentionGate.shouldSkip) {
            logVerbose(
              `line: skipping group message (requireMention, not mentioned) group=${ctx.groupId ?? "unknown"} account=${ctx.accountId}`,
            );
            return;
          }

          ctxPayload.WasMentioned = mentionGate.effectiveWasMentioned;
        }
      }
      // ── end LINE mention gating ──

      // Record inbound activity
      recordChannelRuntimeState({
        channel: "line",
        accountId: resolvedAccountId,
        state: {
          lastInboundAt: Date.now(),
        },
      });

      const shouldShowLoading = Boolean(ctx.userId && !ctx.isGroup);

      // Fetch display name for logging (non-blocking)
      const displayNamePromise = ctx.userId
        ? getUserDisplayName(ctx.userId, { accountId: ctx.accountId })
        : Promise.resolve(ctxPayload.From);

      // Show loading animation while processing (non-blocking, best-effort)
      const stopLoading = shouldShowLoading
        ? startLineLoadingKeepalive({ userId: ctx.userId!, accountId: ctx.accountId })
        : null;

      const displayName = await displayNamePromise;
      logVerbose(`line: received message from ${displayName} (${ctxPayload.From})`);

      // Dispatch to auto-reply system for AI response
      try {
        const textLimit = 5000; // LINE max message length
        let replyTokenUsed = false; // Track if we've used the one-time reply token
        const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
          cfg: config,
          agentId: route.agentId,
          channel: "line",
          accountId: route.accountId,
        });

        const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: config,
          dispatcherOptions: {
            ...prefixOptions,
            deliver: async (payload, _info) => {
              const lineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};

              // Show loading animation before each delivery (non-blocking)
              if (ctx.userId && !ctx.isGroup) {
                void showLoadingAnimation(ctx.userId, { accountId: ctx.accountId }).catch(() => {});
              }

              const { replyTokenUsed: nextReplyTokenUsed } = await deliverLineAutoReply({
                payload,
                lineData,
                to: ctxPayload.From,
                replyToken,
                replyTokenUsed,
                accountId: ctx.accountId,
                textLimit,
                deps: {
                  buildTemplateMessageFromPayload,
                  processLineMessage,
                  chunkMarkdownText,
                  sendLineReplyChunks,
                  replyMessageLine,
                  pushMessageLine,
                  pushTextMessageWithQuickReplies,
                  createQuickReplyItems,
                  createTextMessageWithQuickReplies,
                  pushMessagesLine,
                  createFlexMessage,
                  createImageMessage,
                  createLocationMessage,
                  onReplyError: (replyErr) => {
                    logVerbose(
                      `line: reply token failed, falling back to push: ${String(replyErr)}`,
                    );
                  },
                },
              });
              replyTokenUsed = nextReplyTokenUsed;

              recordChannelRuntimeState({
                channel: "line",
                accountId: resolvedAccountId,
                state: {
                  lastOutboundAt: Date.now(),
                },
              });
            },
            onError: (err, info) => {
              runtime.error?.(danger(`line ${info.kind} reply failed: ${String(err)}`));
            },
          },
          replyOptions: {
            onModelSelected,
          },
        });

        if (!queuedFinal) {
          logVerbose(`line: no response generated for message from ${ctxPayload.From}`);
        }
      } catch (err) {
        runtime.error?.(danger(`line: auto-reply failed: ${String(err)}`));

        // Send error message to user
        if (replyToken) {
          try {
            await replyMessageLine(
              replyToken,
              [{ type: "text", text: "Sorry, I encountered an error processing your message." }],
              { accountId: ctx.accountId },
            );
          } catch (replyErr) {
            runtime.error?.(danger(`line: error reply failed: ${String(replyErr)}`));
          }
        }
      } finally {
        stopLoading?.();
      }
    },
  });

  // Register HTTP webhook handler
  const normalizedPath = normalizePluginHttpPath(webhookPath, "/line/webhook") ?? "/line/webhook";
  const unregisterHttp = registerPluginHttpRoute({
    path: normalizedPath,
    auth: "plugin",
    replaceExisting: true,
    pluginId: "line",
    accountId: resolvedAccountId,
    log: (msg) => logVerbose(msg),
    handler: createLineNodeWebhookHandler({ channelSecret: secret, bot, runtime }),
  });

  logVerbose(`line: registered webhook handler at ${normalizedPath}`);

  // Handle abort signal
  let stopped = false;
  const stopHandler = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    logVerbose(`line: stopping provider for account ${resolvedAccountId}`);
    unregisterHttp();
    recordChannelRuntimeState({
      channel: "line",
      accountId: resolvedAccountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  };

  if (abortSignal?.aborted) {
    stopHandler();
  } else if (abortSignal) {
    abortSignal.addEventListener("abort", stopHandler, { once: true });
    await waitForAbortSignal(abortSignal);
  }

  return {
    account: bot.account,
    handleWebhook: bot.handleWebhook,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}
