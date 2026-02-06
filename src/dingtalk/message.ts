import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { recordInboundSession } from "../channels/session.js";
import { resolveStorePath } from "../config/sessions.js";
import { logVerbose } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { buildAgentSessionKey } from "../routing/resolve-route.js";
import { isSenderAllowed, normalizeAllowFromWithStore, resolveSenderAllowMatch } from "./access.js";
import { resolveDingTalkAccount } from "./accounts.js";
import {
  resolveDingTalkConfig,
  resolveDingTalkGroupConfig,
  resolveDingTalkGroupEnabled,
} from "./config.js";
import { readDingTalkAllowFromStore, upsertDingTalkPairingRequest } from "./pairing-store.js";
import { upsertDingTalkKnownUser } from "./directory-store.js";
import {
  buildDingTalkMediaSystemPrompt,
  processAudioMarkers,
  processFileMarkers,
  processLocalImages,
  processVideoMarkers,
} from "./media.js";
import { DingTalkStreamingSession } from "./ai-card.js";
import { sendDingTalkWebhookText } from "./send.js";
import { getDingTalkOapiToken } from "./auth.js";

const logger = getChildLogger({ module: "dingtalk-message" });

function extractDingTalkContent(data: any): { text: string; messageType: string } {
  const msgtype = data.msgtype || data.msgType || "text";
  switch (msgtype) {
    case "text":
      return { text: data.text?.content?.trim() || "", messageType: "text" };
    case "richText": {
      const parts = data.content?.richText || [];
      const text = parts
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("");
      return { text: text || "[富文本消息]", messageType: "richText" };
    }
    case "picture":
      return { text: "[图片]", messageType: "picture" };
    case "audio":
      return { text: data.content?.recognition || "[语音消息]", messageType: "audio" };
    case "video":
      return { text: "[视频]", messageType: "video" };
    case "file":
      return {
        text: `[文件: ${data.content?.fileName || "文件"}]`,
        messageType: "file",
      };
    default:
      return { text: data.text?.content?.trim() || `[${msgtype}消息]`, messageType: msgtype };
  }
}

export async function processDingTalkMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  data: any;
  log?: any;
  resolvedConfig?: ReturnType<typeof resolveDingTalkConfig>;
}) {
  const cfg = params.cfg;
  const accountId = params.accountId;
  const dtCfg = params.resolvedConfig ?? resolveDingTalkConfig({ cfg, accountId });
  const data = params.data;

  const isGroup = data.conversationType === "2";
  const senderId = data.senderStaffId || data.senderId;
  const senderName = data.senderNick || "Unknown";
  const chatId = data.conversationId;
  const sessionWebhook = data.sessionWebhook;

  const content = extractDingTalkContent(data);
  if (!content.text) {
    return;
  }

  if (senderId) {
    await upsertDingTalkKnownUser({ userId: senderId, name: senderName }).catch(() => {
      // best effort cache for target-name resolution in outbound tools
    });
  }

  // group enabled + policy check
  if (isGroup && !resolveDingTalkGroupEnabled({ cfg, accountId, chatId })) {
    return;
  }

  const storeAllowFrom = await readDingTalkAllowFromStore().catch(() => []);

  // DM policy / pairing
  if (!isGroup) {
    const dmPolicy = dtCfg.dmPolicy;
    if (dmPolicy === "disabled") {
      return;
    }
    if (dmPolicy !== "open") {
      const dmAllow = normalizeAllowFromWithStore({ allowFrom: dtCfg.allowFrom, storeAllowFrom });
      const allowMatch = resolveSenderAllowMatch({ allow: dmAllow, senderId });
      const allowed = dmAllow.hasWildcard || (dmAllow.hasEntries && allowMatch.allowed);
      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await upsertDingTalkPairingRequest({
            userId: senderId,
            name: senderName,
          });
          if (created && sessionWebhook) {
            const account = resolveDingTalkAccount({ cfg, accountId });
            await sendDingTalkWebhookText(
              account.config,
              sessionWebhook,
              [
                "OpenClaw access not configured.",
                "",
                `Your DingTalk User ID: ${senderId}`,
                "",
                `Pairing code: ${code}`,
                "",
                "Ask the OpenClaw admin to approve with:",
                `openclaw pairing approve dingtalk ${code}`,
              ].join("\n"),
            );
          }
        }
        return;
      }
    }
  }

  // group policy + allowlist
  if (isGroup) {
    const groupPolicy = dtCfg.groupPolicy;
    if (groupPolicy === "disabled") {
      return;
    }
    if (groupPolicy === "allowlist") {
      const groupAllow = normalizeAllowFromWithStore({
        allowFrom: dtCfg.groupAllowFrom.length > 0 ? dtCfg.groupAllowFrom : dtCfg.allowFrom,
        storeAllowFrom,
      });
      if (!groupAllow.hasEntries) {
        return;
      }
      if (!isSenderAllowed({ allow: groupAllow, senderId })) {
        return;
      }
    }
  }

  // mention gating
  if (isGroup) {
    const { groupConfig } = resolveDingTalkGroupConfig({ cfg, accountId, chatId });
    const requireMention = groupConfig?.requireMention ?? true;
    const wasMentioned =
      Boolean(data.atUsers?.some((user: any) => user.userId === senderId)) ||
      data.isInAtList === true;
    if (requireMention && !wasMentioned) {
      return;
    }
  }

  const agentId = resolveSessionAgentId({ config: cfg });
  const account = resolveDingTalkAccount({ cfg, accountId });
  const peer = { kind: isGroup ? "group" : "dm", id: isGroup ? chatId : senderId };
  const sessionKey = buildAgentSessionKey({
    agentId,
    channel: "dingtalk",
    accountId,
    peer,
    dmScope: cfg.session?.dmScope ?? "main",
    identityLinks: cfg.session?.identityLinks,
  });

  const ctx = {
    Body: content.text,
    RawBody: content.text,
    From: senderId,
    To: isGroup ? chatId : senderId,
    SenderId: senderId,
    SenderName: senderName,
    ChatType: isGroup ? "group" : "dm",
    Provider: "dingtalk",
    Surface: "dingtalk",
    Timestamp: Date.now(),
    MessageSid: data.msgId || data.messageId,
    AccountId: accountId,
    OriginatingChannel: "dingtalk",
    OriginatingTo: isGroup ? `group:${chatId}` : `user:${senderId}`,
    GroupSystemPrompt: dtCfg.enableMediaUpload ? buildDingTalkMediaSystemPrompt() : undefined,
  };

  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  await recordInboundSession({
    storePath,
    sessionKey,
    ctx,
    updateLastRoute: {
      sessionKey,
      channel: "dingtalk",
      to: isGroup ? `group:${chatId}` : `user:${senderId}`,
      accountId,
    },
    onRecordError: (err) => logVerbose(`dingtalk: failed updating session meta: ${String(err)}`),
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId,
    channel: "dingtalk",
    accountId,
  });
  const streamingSession = dtCfg.streaming
    ? new DingTalkStreamingSession(account.config, { isGroup, senderId, chatId })
    : null;
  let latestStreamText = "";
  let streamClosed = false;
  let streamClosePromise: Promise<void> | null = null;

  const closeStreamingSessionIfNeeded = async () => {
    if (!streamingSession?.isActive() || streamClosed) {
      return;
    }
    if (streamClosePromise) {
      await streamClosePromise;
      return;
    }
    streamClosePromise = (async () => {
      await streamingSession.close(latestStreamText, params.log);
      streamClosed = true;
    })().finally(() => {
      streamClosePromise = null;
    });
    await streamClosePromise;
  };

  try {
    await dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload, info) => {
          if (!payload.text && !payload.mediaUrl && !payload.mediaUrls?.length) {
            return;
          }

          // streaming 更新
          if (streamingSession?.isActive() && info?.kind === "block" && payload.text) {
            latestStreamText = payload.text;
            await streamingSession.update(payload.text, params.log);
            return;
          }

          if (streamingSession?.isActive() && info?.kind === "final") {
            const oapiToken = dtCfg.enableMediaUpload
              ? await getDingTalkOapiToken(account.config)
              : null;
            let finalText = payload.text ?? "";
            finalText = await processLocalImages(finalText, oapiToken, params.log);
            finalText = await processVideoMarkers(
              finalText,
              "",
              account.config,
              oapiToken,
              params.log,
              true,
              streamingSession.target,
            );
            finalText = await processAudioMarkers(
              finalText,
              "",
              account.config,
              oapiToken,
              params.log,
              true,
              streamingSession.target,
            );
            finalText = await processFileMarkers(
              finalText,
              "",
              account.config,
              oapiToken,
              params.log,
              true,
              streamingSession.target,
            );
            latestStreamText = finalText;
            await closeStreamingSessionIfNeeded();
            return;
          }

          // 非流式：直接 webhook 回复
          if (payload.text && sessionWebhook) {
            let finalText = payload.text;
            if (dtCfg.enableMediaUpload) {
              const oapiToken = await getDingTalkOapiToken(account.config);
              finalText = await processLocalImages(finalText, oapiToken, params.log);
              finalText = await processVideoMarkers(
                finalText,
                sessionWebhook,
                account.config,
                oapiToken,
                params.log,
              );
              finalText = await processAudioMarkers(
                finalText,
                sessionWebhook,
                account.config,
                oapiToken,
                params.log,
              );
              finalText = await processFileMarkers(
                finalText,
                sessionWebhook,
                account.config,
                oapiToken,
                params.log,
              );
            }
            await sendDingTalkWebhookText(account.config, sessionWebhook, finalText, {
              useMarkdown: true,
              atUserId: isGroup ? senderId : null,
            });
          }
        },
        onError: (err) => logger.error(`Reply error: ${String(err)}`),
        onReplyStart: async () => {
          if (streamingSession && !streamingSession.isActive()) {
            await streamingSession.start(params.log);
          }
        },
        onIdle: () => {
          void closeStreamingSessionIfNeeded().catch((err) => {
            logger.error(`DingTalk streaming close on idle failed: ${String(err)}`);
          });
        },
      },
      replyOptions: {
        disableBlockStreaming: !dtCfg.blockStreaming,
        onModelSelected,
      },
    });
  } finally {
    await closeStreamingSessionIfNeeded().catch((err) => {
      logger.error(`DingTalk streaming close after dispatch failed: ${String(err)}`);
    });
  }
}
