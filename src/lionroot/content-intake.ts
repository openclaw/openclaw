/**
 * Content intake pipe for iMessage → Zulip forwarding + agent dispatch.
 *
 * Extracted from src/imessage/monitor/monitor-provider.ts to minimize
 * upstream diff. The upstream file now calls handleContentIntake() with
 * a single ~8 line hook instead of ~200 lines of inline logic.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveHumanDelayConfig } from "../agents/identity.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import type { HistoryEntry } from "../auto-reply/reply/history.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import type { OpenClawConfig } from "../config/config.js";
import { readSessionUpdatedAt, resolveStorePath } from "../config/sessions.js";
import { danger, logVerbose } from "../globals.js";
import type { createIMessageRpcClient } from "../imessage/client.js";
import type { createSentMessageCache } from "../imessage/monitor/echo-cache.js";
import {
  buildIMessageInboundContext,
  type IMessageInboundDispatchDecision,
} from "../imessage/monitor/inbound-processing.js";
import type { resolveRuntime } from "../imessage/monitor/runtime.js";
import type { IMessagePayload } from "../imessage/monitor/types.js";
import type { sendMessageIMessage } from "../imessage/send.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { buildAgentSessionKey, pickFirstExistingAgentId } from "../routing/resolve-route.js";
import { truncateUtf16Safe } from "../utils.js";
import { maybeHandleFoodImageCapture } from "./food-capture.js";
import {
  buildForwardTarget,
  buildTopicSuffix,
  formatForwardAck,
  formatForwardBody,
  formatGeneralForwardBody,
  getLastForward,
  getRecentTweetForward,
  recordLastForward,
  recordRecentTweetForward,
  resolveContentForwardConfig,
  type ResolvedContentForwardConfig,
} from "./routing/content-forward.js";
import {
  applyContentRouteOverride,
  classifyContentWithLLM,
  isInvestigationClassification,
  isRecognizedContentRoute,
  resolveContentRoutingConfig,
  resolveContentRouteFastPath,
  resolveInvestigationFastPath,
  resolveTwitterContent,
  TWITTER_STATUS_RE,
  URL_RE,
} from "./routing/content-route.js";
import {
  resolveInvestigationConfig,
  runBoundedInvestigation,
} from "./routing/investigation-orchestrator.js";

const IMESSAGE_REPLY_TIMEOUT_SECONDS = 90;
const FORWARDED_AGENT_FAILURE_SUMMARY =
  "⚠️ Forwarded to Zulip, but the agent hit a provider error while processing it. Retry the thread if needed.";
const MAX_ROUTING_ATTACHMENT_TEXT_CHARS = 12_000;
const MAX_ROUTING_ATTACHMENT_FILES = 2;
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".log",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".csv",
  ".tsv",
]);

function isTextLikeAttachment(params: { filePath: string; mediaType?: string }): boolean {
  const normalizedType = params.mediaType?.split(";")[0]?.trim().toLowerCase();
  if (normalizedType?.startsWith("text/")) {
    return true;
  }
  if (
    normalizedType === "application/json" ||
    normalizedType === "application/xml" ||
    normalizedType === "text/xml" ||
    normalizedType === "application/yaml" ||
    normalizedType === "text/yaml"
  ) {
    return true;
  }
  return TEXT_ATTACHMENT_EXTENSIONS.has(path.extname(params.filePath).toLowerCase());
}

async function extractAttachmentTextForRouting(params: {
  mediaPaths: string[];
  mediaTypes: Array<string | undefined>;
}): Promise<string | undefined> {
  if (!params.mediaPaths.length) {
    return undefined;
  }
  const sections: string[] = [];
  let remaining = MAX_ROUTING_ATTACHMENT_TEXT_CHARS;

  for (let index = 0; index < params.mediaPaths.length; index += 1) {
    if (sections.length >= MAX_ROUTING_ATTACHMENT_FILES || remaining <= 0) {
      break;
    }
    const filePath = params.mediaPaths[index];
    if (!filePath) {
      continue;
    }
    const mediaType = params.mediaTypes[index];
    if (!isTextLikeAttachment({ filePath, mediaType })) {
      continue;
    }
    try {
      const buffer = await fs.readFile(filePath);
      const text = buffer.toString("utf8").replaceAll("\u0000", "").trim();
      if (!text) {
        continue;
      }
      const fileName = path.basename(filePath);
      const snippet = text.slice(0, remaining);
      sections.push(`[Attachment: ${fileName}]\n${snippet}`);
      remaining -= snippet.length;
    } catch {
      continue;
    }
  }

  if (sections.length === 0) {
    return undefined;
  }
  return sections.join("\n\n");
}

/**
 * Dispatch agent processing for a forwarded message, re-routing replies to Zulip.
 * The agent processes the message normally but its responses go to the Zulip topic
 * instead of iMessage. After the agent responds, a 1-line summary is sent to iMessage.
 */
function assignForwardedAgentRoute(params: {
  cfg: OpenClawConfig;
  decision: IMessageInboundDispatchDecision;
  agentId: string;
  accountId: string;
  sessionSuffix?: string;
}): void {
  params.decision.route = {
    ...params.decision.route,
    agentId: params.agentId,
    sessionKey:
      buildAgentSessionKey({
        agentId: params.agentId,
        channel: "imessage",
        accountId: params.accountId,
        peer: {
          kind: params.decision.isGroup ? "group" : "direct",
          id: params.decision.isGroup
            ? String(params.decision.chatId ?? params.decision.groupId ?? "unknown")
            : params.decision.senderNormalized,
        },
        dmScope: params.cfg.session?.dmScope,
      }).toLowerCase() + (params.sessionSuffix ? `:${params.sessionSuffix}` : ""),
    matchedBy: "content" as const,
  };
}

function resolveZulipForwardAccountId(cfg: OpenClawConfig, agentId: string): string | undefined {
  const zulip = (cfg.channels as Record<string, unknown> | undefined)?.zulip as
    | { accounts?: Record<string, unknown> }
    | undefined;
  const trimmedAgentId = agentId.trim();
  if (!trimmedAgentId || !zulip?.accounts) {
    return undefined;
  }
  return Object.hasOwn(zulip.accounts, trimmedAgentId) ? trimmedAgentId : undefined;
}

function shouldForwardClassification(params: {
  forwardCfg: ResolvedContentForwardConfig;
  agentId: string;
}): boolean {
  const normalizedAgentId = params.agentId.trim().toLowerCase();
  if (!normalizedAgentId) {
    return false;
  }
  if (params.forwardCfg.streams[normalizedAgentId]) {
    return true;
  }
  return params.forwardCfg.streamPattern.includes("{agent}");
}

async function dispatchForwardedToAgent(params: {
  cfg: OpenClawConfig;
  decision: IMessageInboundDispatchDecision;
  message: IMessagePayload;
  previousTimestamp?: number;
  remoteHost?: string;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  media: {
    path?: string;
    type?: string;
    paths?: string[];
    types?: Array<string | undefined>;
  };
  target: { channel: string; to: string };
  zulipAccountId?: string;
  accountInfo: { accountId: string; config: { blockStreaming?: boolean } };
  runtime: ReturnType<typeof resolveRuntime>;
  client: Awaited<ReturnType<typeof createIMessageRpcClient>>;
  mediaMaxBytes: number;
  textLimit: number | undefined;
  sentMessageCache: ReturnType<typeof createSentMessageCache>;
  chatId?: number;
  sender: string;
  sendMessage: typeof sendMessageIMessage;
}): Promise<void> {
  const {
    cfg,
    decision,
    message,
    target,
    zulipAccountId,
    accountInfo,
    runtime,
    client,
    mediaMaxBytes,
    chatId,
    sender,
    sendMessage,
  } = params;

  const { ctxPayload } = buildIMessageInboundContext({
    cfg,
    decision,
    message,
    previousTimestamp: params.previousTimestamp,
    remoteHost: params.remoteHost,
    historyLimit: params.historyLimit,
    groupHistories: params.groupHistories,
    media: params.media,
  });

  // Override reply target to Zulip
  ctxPayload.To = target.to;

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: decision.route.agentId,
    channel: "imessage",
    accountId: decision.route.accountId,
  });

  // Collect agent reply/error text for the iMessage summary.
  // Prefer a successful final reply. Never surface raw provider errors back to iMessage.
  let agentReplyText = "";
  let agentFinalReplyText = "";
  let agentErrorText = "";

  const dispatcher = createReplyDispatcher({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, decision.route.agentId),
    deliver: async (payload, info) => {
      // Send replies to Zulip instead of iMessage
      await deliverOutboundPayloads({
        cfg,
        channel: target.channel as "zulip",
        to: target.to,
        accountId: zulipAccountId,
        payloads: [payload],
        skipQueue: true,
      });
      if (payload.isError) {
        if (!agentErrorText && payload.text) {
          agentErrorText = payload.text;
        }
        return;
      }
      if (info.kind === "final" && !agentFinalReplyText && payload.text) {
        agentFinalReplyText = payload.text;
      }
      if (!agentReplyText && payload.text) {
        agentReplyText = payload.text;
      }
    },
    onError: (err, info) => {
      runtime.error?.(danger(`content-forward ${info.kind} reply failed: ${String(err)}`));
    },
  });

  try {
    await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        disableBlockStreaming:
          typeof accountInfo.config.blockStreaming === "boolean"
            ? !accountInfo.config.blockStreaming
            : undefined,
        onModelSelected,
        timeoutOverrideSeconds: IMESSAGE_REPLY_TIMEOUT_SECONDS,
      },
    });
  } catch (err) {
    runtime.error?.(danger(`content-forward dispatch failed: ${String(err)}`));
    if (!agentErrorText) {
      agentErrorText = String(err);
    }
  }

  // Send a brief summary back to iMessage so the user knows the agent responded.
  // Prefer successful final replies. If the run only produced errors, send a generic
  // failure note instead of leaking raw provider internals into iMessage.
  const summaryText = agentFinalReplyText || agentReplyText;
  const summary = summaryText
    ? `${decision.route.agentId}: ${truncateUtf16Safe(summaryText.split("\n")[0] ?? "", 100)}`
    : agentErrorText
      ? FORWARDED_AGENT_FAILURE_SUMMARY
      : "";
  if (summary) {
    try {
      await sendMessage(sender, summary, {
        client,
        maxBytes: mediaMaxBytes,
        accountId: accountInfo.accountId,
        ...(chatId ? { chatId } : {}),
      });
    } catch (err) {
      logVerbose(`content-forward: iMessage summary failed: ${String(err)}`);
    }
  }
}

export type ContentIntakeParams = {
  cfg: OpenClawConfig;
  decision: IMessageInboundDispatchDecision;
  message: IMessagePayload;
  bodyText: string;
  mediaPath?: string;
  mediaType?: string;
  mediaPaths: string[];
  mediaTypes: Array<string | undefined>;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  remoteHost?: string;
  accountInfo: { accountId: string; config: { blockStreaming?: boolean } };
  runtime: ReturnType<typeof resolveRuntime>;
  client: Awaited<ReturnType<typeof createIMessageRpcClient>>;
  mediaMaxBytes: number;
  textLimit: number | undefined;
  sentMessageCache: ReturnType<typeof createSentMessageCache>;
  chatId?: number;
  sender: string;
  sendMessage: typeof sendMessageIMessage;
};

/**
 * Handle content-based routing and forwarding for inbound iMessage DMs.
 *
 * Returns `{ handled: true }` if the message was forwarded to Zulip (caller
 * should skip normal dispatch). Returns `{ handled: false }` if normal
 * dispatch should proceed — but the decision.route may have been mutated
 * with a content-based override.
 */
export async function handleContentIntake(
  params: ContentIntakeParams,
): Promise<{ handled: boolean }> {
  const {
    cfg,
    decision,
    message,
    bodyText,
    mediaPath,
    mediaType,
    mediaPaths,
    mediaTypes,
    historyLimit,
    groupHistories,
    remoteHost,
    accountInfo,
    runtime,
    client,
    mediaMaxBytes,
    textLimit,
    sentMessageCache,
    chatId,
    sender,
    sendMessage,
  } = params;

  const contentRoutingCfg = resolveContentRoutingConfig(cfg);
  const forwardCfg = resolveContentForwardConfig(cfg);
  const investigationCfg = resolveInvestigationConfig({
    contentRoutingDefaultAgentId: contentRoutingCfg?.defaultAgentId,
    investigation: contentRoutingCfg?.investigation,
  });

  // Resolve Zulip base URL for narrow links in ack messages.
  const zulipBaseUrl = resolveZulipBaseUrl(cfg);

  const foodCaptureHandled = await maybeHandleFoodImageCapture({
    cfg,
    bodyText,
    mediaPath,
    mediaType,
    sender,
    accountId: accountInfo.accountId,
    isGroup: decision.isGroup,
    sendMessage,
    sendOptions: {
      client,
      maxBytes: mediaMaxBytes,
      accountId: accountInfo.accountId,
      ...(chatId ? { chatId } : {}),
    },
  });
  if (foodCaptureHandled) {
    return { handled: true };
  }

  const sendIMessageResponse = async (text: string) => {
    await sendMessage(sender, text, {
      client,
      maxBytes: mediaMaxBytes,
      accountId: accountInfo.accountId,
      ...(chatId ? { chatId } : {}),
    });
  };

  const handleInvestigationClassification = async (params: {
    classification: Extract<
      Awaited<ReturnType<typeof classifyContentWithLLM>>,
      { kind: "recognized" }
    >;
    tweetText?: string;
    tweetId?: string;
  }): Promise<{ handled: boolean }> => {
    const agentId = pickFirstExistingAgentId(cfg, params.classification.agentId);
    assignForwardedAgentRoute({
      cfg,
      decision,
      agentId,
      accountId: accountInfo.accountId,
      sessionSuffix: "investigation",
    });

    const investigationResult = await runBoundedInvestigation({
      cfg,
      decision,
      message,
      bodyText,
      historyLimit,
      groupHistories,
      remoteHost,
      media: { path: mediaPath, type: mediaType, paths: mediaPaths, types: mediaTypes },
      accountInfo,
      investigation: investigationCfg,
      reason: params.classification.reason,
    });

    let responseText = investigationResult.replyText;
    if (
      investigationResult.shouldPromote &&
      investigationResult.promotionText &&
      forwardCfg &&
      shouldForwardClassification({ forwardCfg, agentId })
    ) {
      const zulipAccountId = resolveZulipForwardAccountId(cfg, agentId);
      if (!zulipAccountId) {
        logVerbose(
          `content-investigation: no Zulip account configured for ${agentId}; using channel default`,
        );
      }
      const topicInfo = buildTopicSuffix({
        text: bodyText,
        mediaType,
        tweetText: params.tweetText,
      });
      const target = buildForwardTarget({
        config: forwardCfg,
        agentId,
        category: params.classification.category,
        topicSuffix: truncateUtf16Safe(topicInfo.suffix, 40),
        topicPrefix: topicInfo.prefix,
      });
      const forwardResults = await deliverOutboundPayloads({
        cfg,
        channel: target.channel as "zulip",
        to: target.to,
        accountId: zulipAccountId,
        payloads: [{ text: investigationResult.promotionText }],
        skipQueue: true,
      });
      const streamName = target.to.match(/^stream:([^:]+):/)?.[1] ?? agentId;
      const topic = target.to.match(/:topic:(.+)$/)?.[1];
      const ack = formatForwardAck({
        agentId,
        stream: streamName,
        topic,
        zulipBaseUrl,
        zulipMessageId: forwardResults[0]?.messageId,
      });
      responseText = `${responseText}

${ack}`;
    }

    await sendIMessageResponse(responseText);
    logVerbose(
      `content-investigation: ${params.classification.reason}${params.classification.category ? `:${params.classification.category}` : ""} → ${agentId}`,
    );
    return { handled: true };
  };

  if (contentRoutingCfg && !decision.isGroup) {
    const investigationFastPath = resolveInvestigationFastPath({
      text: bodyText,
      investigationEnabled: investigationCfg.enabled,
      agentId: investigationCfg.defaultAgentId,
    });
    if (isRecognizedContentRoute(investigationFastPath)) {
      return await handleInvestigationClassification({ classification: investigationFastPath });
    }

    if (forwardCfg) {
      // Follow-up to a recent forward: if the same sender sends a non-URL message
      // within the TTL window, append it to the same Zulip topic and dispatch agent.
      const lastFwd = getLastForward(decision.senderNormalized);
      const hasNewUrl = bodyText.match(URL_RE) !== null;
      if (lastFwd && !hasNewUrl) {
        // Forward follow-up text (and media) to existing Zulip topic
        const followUpPayloads: ReplyPayload[] = [
          { text: bodyText, ...(mediaPath ? { mediaUrl: mediaPath } : {}) },
        ];
        const followUpZulipAccountId = resolveZulipForwardAccountId(cfg, lastFwd.agentId);
        if (!followUpZulipAccountId) {
          logVerbose(
            `content-forward: no Zulip account configured for ${lastFwd.agentId}; using channel default`,
          );
        }
        await deliverOutboundPayloads({
          cfg,
          channel: lastFwd.channel as "zulip",
          to: lastFwd.to,
          accountId: followUpZulipAccountId,
          payloads: followUpPayloads,
          skipQueue: true,
        });

        // Ack to iMessage
        const followUpTopic = lastFwd.to.match(/:topic:(.+)$/)?.[1];
        const ack = formatForwardAck({
          agentId: lastFwd.agentId,
          stream: lastFwd.stream,
          topic: followUpTopic,
          zulipBaseUrl,
          zulipMessageId: lastFwd.messageId,
        });
        await sendMessage(sender, ack, {
          client,
          maxBytes: mediaMaxBytes,
          accountId: accountInfo.accountId,
          ...(chatId ? { chatId } : {}),
        });

        // Dispatch agent for processing — re-route replies to Zulip
        const followUpAgentId = pickFirstExistingAgentId(cfg, lastFwd.agentId);
        assignForwardedAgentRoute({
          cfg,
          decision,
          agentId: followUpAgentId,
          accountId: accountInfo.accountId,
        });

        await dispatchForwardedToAgent({
          cfg,
          decision,
          message,
          previousTimestamp: readSessionUpdatedAt({
            storePath: resolveStorePath(cfg.session?.store, { agentId: followUpAgentId }),
            sessionKey: decision.route.sessionKey,
          }),
          remoteHost,
          historyLimit,
          groupHistories,
          media: { path: mediaPath, type: mediaType, paths: mediaPaths, types: mediaTypes },
          target: lastFwd,
          zulipAccountId: followUpZulipAccountId,
          accountInfo,
          runtime,
          client,
          mediaMaxBytes,
          textLimit,
          sentMessageCache,
          chatId,
          sender,
          sendMessage,
        });

        // Refresh follow-up timestamp
        recordLastForward(decision.senderNormalized, {
          ...lastFwd,
          timestamp: Date.now(),
        });

        logVerbose(`content-forward follow-up → ${lastFwd.channel}:${lastFwd.agentId}`);
        return { handled: true };
      }
    }

    // New forward: classify content and route to agent's Zulip stream
    // 1. Resolve tweet text if it's a Twitter URL
    const tweetId = bodyText.match(TWITTER_STATUS_RE)?.[1];
    const duplicateTweetForward =
      forwardCfg && tweetId
        ? await getRecentTweetForward(decision.senderNormalized, tweetId)
        : null;
    if (duplicateTweetForward) {
      const duplicateAckTopic = duplicateTweetForward.to.match(/:topic:(.+)$/)?.[1];
      const duplicateAck = formatForwardAck({
        agentId: duplicateTweetForward.agentId,
        stream: duplicateTweetForward.stream,
        topic: duplicateAckTopic,
        zulipBaseUrl,
        zulipMessageId: duplicateTweetForward.messageId,
      });
      await sendMessage(sender, duplicateAck, {
        client,
        maxBytes: mediaMaxBytes,
        accountId: accountInfo.accountId,
        ...(chatId ? { chatId } : {}),
      });
      const refreshedDuplicateForward = {
        ...duplicateTweetForward,
        timestamp: Date.now(),
      };
      recordLastForward(decision.senderNormalized, refreshedDuplicateForward);
      if (tweetId) {
        await recordRecentTweetForward(
          decision.senderNormalized,
          tweetId,
          refreshedDuplicateForward,
        );
      }
      logVerbose(
        `content-forward dedupe: reused ${duplicateTweetForward.channel}:${duplicateTweetForward.agentId} for tweet ${tweetId}`,
      );
      return { handled: true };
    }

    let tweetText: string | undefined;
    let tweetUrl: string | undefined;
    if (tweetId) {
      const tweet = await resolveTwitterContent(bodyText);
      if (tweet) {
        tweetText = tweet.tweetText;
        tweetUrl = bodyText.match(URL_RE)?.[0] ?? bodyText;
      }
    }
    const attachmentText = await extractAttachmentTextForRouting({
      mediaPaths,
      mediaTypes,
    });

    // 2. Classify content
    const fastPathClassification = resolveContentRouteFastPath({ text: bodyText, mediaType });
    const classification =
      fastPathClassification ??
      (await classifyContentWithLLM({
        text: bodyText,
        mediaType,
        attachmentText,
        tweetText,
        model: contentRoutingCfg.model ?? "qwen3.5:9b",
        ollamaUrl: contentRoutingCfg.ollamaUrl ?? "http://localhost:11434",
        agentDescriptions: contentRoutingCfg.agents,
      }));

    if (!isRecognizedContentRoute(classification)) {
      logVerbose(`content-forward: ${classification.reason}; falling back to normal dispatch`);
    } else if (investigationCfg.enabled && isInvestigationClassification(classification)) {
      return await handleInvestigationClassification({
        classification,
        tweetText,
        tweetId,
      });
    } else {
      const agentId = pickFirstExistingAgentId(cfg, classification.agentId);
      const category = classification.category;
      if (!forwardCfg) {
        logVerbose("content-forward: forward disabled; falling back to normal dispatch");
      } else if (!shouldForwardClassification({ forwardCfg, agentId })) {
        logVerbose(
          `content-forward: skipped forward for ${agentId || "(empty)"}; falling back to normal dispatch`,
        );
      } else {
        const zulipAccountId = resolveZulipForwardAccountId(cfg, agentId);
        if (!zulipAccountId) {
          logVerbose(
            `content-forward: no Zulip account configured for ${agentId}; using channel default`,
          );
        }

        // 3. Build topic suffix and target
        const topicInfo = buildTopicSuffix({ text: bodyText, mediaType, tweetText });
        const target = buildForwardTarget({
          config: forwardCfg,
          agentId,
          category,
          topicSuffix: truncateUtf16Safe(topicInfo.suffix, 40),
          topicPrefix: topicInfo.prefix,
        });

        // 4. Forward content to Zulip
        const forwardPayloads: ReplyPayload[] = [];
        if (tweetText && tweetUrl) {
          forwardPayloads.push({
            text: formatForwardBody({
              tweetText,
              tweetUrl,
              classification,
            }),
          });
        } else {
          forwardPayloads.push({
            text: formatGeneralForwardBody({
              text: bodyText,
              mediaType,
              classification,
            }),
            ...(mediaPath ? { mediaUrl: mediaPath } : {}),
          });
        }
        const forwardResults = await deliverOutboundPayloads({
          cfg,
          channel: target.channel as "zulip",
          to: target.to,
          accountId: zulipAccountId,
          payloads: forwardPayloads,
          skipQueue: true,
        });

        // 5. Ack to iMessage sender
        const streamName = target.to.match(/^stream:([^:]+):/)?.[1] ?? agentId;
        const topic = target.to.match(/:topic:(.+)$/)?.[1];
        const ack = formatForwardAck({
          agentId,
          stream: streamName,
          topic,
          zulipBaseUrl,
          zulipMessageId: forwardResults[0]?.messageId,
        });
        await sendMessage(sender, ack, {
          client,
          maxBytes: mediaMaxBytes,
          accountId: accountInfo.accountId,
          ...(chatId ? { chatId } : {}),
        });

        // 6. Remember forward for follow-ups
        const forwardEntry = {
          channel: target.channel,
          to: target.to,
          agentId,
          stream: streamName,
          messageId: forwardResults[0]?.messageId,
          ...(tweetId ? { tweetId } : {}),
          ...(tweetText ? { tweetText } : {}),
          ...(category ? { category } : {}),
          timestamp: Date.now(),
        };
        recordLastForward(decision.senderNormalized, forwardEntry);
        if (tweetId) {
          await recordRecentTweetForward(decision.senderNormalized, tweetId, forwardEntry);
        }

        // 7. Dispatch agent for processing — re-route replies to Zulip
        assignForwardedAgentRoute({
          cfg,
          decision,
          agentId,
          accountId: accountInfo.accountId,
        });

        await dispatchForwardedToAgent({
          cfg,
          decision,
          message,
          previousTimestamp: readSessionUpdatedAt({
            storePath: resolveStorePath(cfg.session?.store, { agentId }),
            sessionKey: decision.route.sessionKey,
          }),
          remoteHost,
          historyLimit,
          groupHistories,
          media: { path: mediaPath, type: mediaType, paths: mediaPaths, types: mediaTypes },
          target: { channel: target.channel, to: target.to },
          zulipAccountId,
          accountInfo,
          runtime,
          client,
          mediaMaxBytes,
          textLimit,
          sentMessageCache,
          chatId,
          sender,
          sendMessage,
        });

        logVerbose(
          `content-forward: ${classification.reason}${category ? `:${category}` : ""}${classification.agentId !== agentId ? ` (resolved → ${agentId})` : ""} → ${target.channel}:${agentId}`,
        );
        return { handled: true };
      }
    }
  }

  // Content-based routing override: classify message content to pick the right agent.
  if (contentRoutingCfg) {
    const contentOverride = await applyContentRouteOverride({
      cfg,
      contentRoutingCfg,
      text: bodyText,
      mediaType,
      peer: decision.senderNormalized,
      isGroup: decision.isGroup,
      accountId: accountInfo.accountId,
      dmScope: cfg.session?.dmScope,
      logVerbose,
    });
    if (contentOverride) {
      decision.route = {
        ...decision.route,
        agentId: contentOverride.agentId,
        sessionKey: contentOverride.sessionKey,
        matchedBy: contentOverride.matchedBy,
      };
    }
  }

  return { handled: false };
}

/**
 * Resolve the Zulip server base URL from the first configured Zulip account.
 */
function resolveZulipBaseUrl(cfg: OpenClawConfig): string | undefined {
  const accounts = (cfg.channels as Record<string, unknown> | undefined)?.zulip as
    | { accounts?: Record<string, { baseUrl?: string }> }
    | undefined;
  if (!accounts?.accounts) {
    return undefined;
  }
  for (const acct of Object.values(accounts.accounts)) {
    if (acct.baseUrl) {
      return acct.baseUrl.replace(/\/+$/, "");
    }
  }
  return undefined;
}
