import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { rewriteTranscriptEntriesInSessionFile } from "../../agents/pi-embedded-runner/transcript-rewrite.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  interactiveReplyToPresentation,
  normalizeInteractiveReply,
  renderMessagePresentationFallbackText,
} from "../../interactive/payload.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import { safeJsonStringify } from "../../utils/safe-json.js";
import { attachManagedOutgoingImagesToMessage } from "../managed-image-attachments.js";
import { readSessionTranscriptIndex } from "../session-transcript-index.fs.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  applyDisplayTextToAssistantContent,
  buildAssistantDisplayContentFromReplyPayloads,
  buildAssistantMediaFallbackText,
  extractAssistantDisplayTextFromContent,
  hasAssistantDisplayMediaContent,
  sanitizeAssistantDisplayText,
  stripManagedOutgoingAssistantContentBlocks,
  type AssistantDisplayContentBlock,
} from "./chat-assistant-content.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";
import type { GatewayRequestContext } from "./types.js";

type SourceReplyTranscriptMirrorMetadata = NonNullable<
  ReturnType<typeof getReplyPayloadMetadata>
>["sourceReplyTranscriptMirror"];

type AppendAssistantTranscriptMessage = (params: {
  message: string;
  content?: Array<Record<string, unknown>>;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  cfg?: OpenClawConfig;
}) => Promise<{
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
}>;

type ResolveTranscriptPath = (params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}) => string | null;

type BroadcastFinal = (params: {
  runId: string;
  sessionKey: string;
  message: Record<string, unknown>;
}) => void;

const RICH_SOURCE_REPLY_FALLBACK_MAX_CHARS = 8_000;
const SOURCE_REPLY_MIRROR_RECHECK_DELAYS_MS = [10, 25, 50, 100, 250, 500] as const;

export function isInternalSourceReplyPayload(
  payload: ReplyPayload | undefined,
): payload is ReplyPayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return Boolean(getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror);
}

function truncateRichSourceReplyFallbackText(text: string): string {
  return text.length <= RICH_SOURCE_REPLY_FALLBACK_MAX_CHARS
    ? text
    : `${text.slice(0, RICH_SOURCE_REPLY_FALLBACK_MAX_CHARS)}\n...(truncated)...`;
}

function buildRichSourceReplyFallbackText(payload: ReplyPayload): string | undefined {
  const parts: string[] = [];
  if (payload.presentation) {
    const text = renderMessagePresentationFallbackText({
      presentation: payload.presentation,
    }).trim();
    if (text) {
      parts.push(text);
    }
  }
  if (payload.interactive) {
    const normalizedInteractive = normalizeInteractiveReply(payload.interactive);
    const interactivePresentation = normalizedInteractive
      ? interactiveReplyToPresentation(normalizedInteractive)
      : undefined;
    const text = interactivePresentation
      ? renderMessagePresentationFallbackText({
          presentation: interactivePresentation,
        }).trim()
      : undefined;
    if (text && !parts.includes(text)) {
      parts.push(text);
    }
  }
  if (
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData) &&
    Object.keys(payload.channelData).length > 0
  ) {
    const json = safeJsonStringify(payload.channelData);
    if (json && json !== "{}") {
      parts.push(`Channel data:\n${json}`);
    }
  }
  const text = parts.join("\n\n").trim();
  return sanitizeAssistantDisplayText(truncateRichSourceReplyFallbackText(text));
}

function mergeSourceReplyDisplayText(
  primaryText: string | undefined,
  richFallbackText: string | undefined,
): string | undefined {
  const primary = sanitizeAssistantDisplayText(primaryText);
  const rich = sanitizeAssistantDisplayText(richFallbackText);
  if (!primary) {
    return rich;
  }
  if (!rich || primary.includes(rich)) {
    return primary;
  }
  if (rich.includes(primary)) {
    return rich;
  }
  return `${primary}\n\n${rich}`;
}

function sourceReplyMirrorHasDurableContent(
  metadata: SourceReplyTranscriptMirrorMetadata | undefined,
): boolean {
  return Boolean(
    metadata?.text?.trim() || metadata?.mediaUrls?.some((mediaUrl) => mediaUrl.trim()),
  );
}

function normalizeSourceReplyMirrorMediaUrls(mediaUrls: readonly string[] | undefined): string[] {
  return mediaUrls?.map((mediaUrl) => mediaUrl.trim()).filter(Boolean) ?? [];
}

function sourceReplyMirrorMediaUrlsEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const normalizedLeft = normalizeSourceReplyMirrorMediaUrls(left);
  const normalizedRight = normalizeSourceReplyMirrorMediaUrls(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((mediaUrl, index) => mediaUrl === normalizedRight[index]);
}

function sourceReplyContentNeedsMirrorUpgrade(params: {
  metadata: SourceReplyTranscriptMirrorMetadata | undefined;
  displayPayload: ReplyPayload;
  displayReply?: string;
  content: readonly AssistantDisplayContentBlock[] | undefined;
  richSourceReplyFallback?: string;
}): boolean {
  if (!params.content?.length) {
    return false;
  }
  if (params.displayPayload.sensitiveMedia === true) {
    return true;
  }
  if (params.richSourceReplyFallback || hasAssistantDisplayMediaContent(params.content)) {
    return true;
  }
  const metadataText = params.metadata?.text?.trim() ?? "";
  const displayText = params.displayReply?.trim() ?? "";
  if (metadataText !== displayText) {
    return true;
  }
  return !sourceReplyMirrorMediaUrlsEqual(
    params.metadata?.mediaUrls,
    resolveSendableOutboundReplyParts(params.displayPayload).mediaUrls,
  );
}

function findAssistantTranscriptEntryByIdempotencyKey(
  index: Awaited<ReturnType<typeof readSessionTranscriptIndex>>,
  idempotencyKey: string,
) {
  return index?.entries.toReversed().find((entry) => {
    const message = entry.record.message as Record<string, unknown> | undefined;
    return (
      Boolean(entry.id) &&
      message?.role === "assistant" &&
      message.idempotencyKey === idempotencyKey
    );
  });
}

function buildBroadcastContentForManagedImageState(params: {
  content: AssistantDisplayContentBlock[] | undefined;
  displayText: string | undefined;
  managedOutgoingImagesAttached: boolean;
}): AssistantDisplayContentBlock[] | undefined {
  if (params.managedOutgoingImagesAttached) {
    return params.content;
  }
  const strippedContent = stripManagedOutgoingAssistantContentBlocks(params.content);
  if (strippedContent?.length) {
    return strippedContent;
  }
  return params.displayText ? [{ type: "text", text: params.displayText }] : undefined;
}

async function waitForAssistantTranscriptEntryByIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
) {
  for (const delayMs of SOURCE_REPLY_MIRROR_RECHECK_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const target = findAssistantTranscriptEntryByIdempotencyKey(
      await readSessionTranscriptIndex(transcriptPath),
      idempotencyKey,
    );
    if (target) {
      return target;
    }
  }
  return undefined;
}

async function buildInternalChatAssistantMediaMessage(
  payloads: ReplyPayload[],
  options?: {
    localRoots?: readonly string[];
    onLocalAudioAccessDenied?: (message: string) => void;
  },
): Promise<{ content: Array<Record<string, unknown>>; transcriptText: string } | null> {
  return await buildWebchatAssistantMessageFromReplyPayloads(payloads, {
    localRoots: options?.localRoots,
    onLocalAudioAccessDenied: (err) => {
      options?.onLocalAudioAccessDenied?.(formatForLog(err));
    },
  });
}

export function createInternalSourceReplyProjector(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  accountId?: string;
  clientRunId: string;
  backingSessionId?: string | null;
  initialSessionFile?: string;
  appendAssistantTranscriptMessage: AppendAssistantTranscriptMessage;
  buildTranscriptReplyText: (payloads: ReplyPayload[]) => string;
  broadcastFinal: BroadcastFinal;
  context: Pick<GatewayRequestContext, "logGateway">;
  resolveTranscriptPath: ResolveTranscriptPath;
}) {
  let projectionCount = 0;

  const rewriteMirrorContent = async (input: {
    transcriptPath: string;
    sourceReplyRunId: string;
    content: AssistantDisplayContentBlock[];
  }): Promise<boolean> => {
    const target = findAssistantTranscriptEntryByIdempotencyKey(
      await readSessionTranscriptIndex(input.transcriptPath),
      input.sourceReplyRunId,
    );
    const targetMessage = target?.record.message as Record<string, unknown> | undefined;
    if (!target?.id || !targetMessage) {
      return false;
    }
    const rewritten = await rewriteTranscriptEntriesInSessionFile({
      sessionFile: input.transcriptPath,
      sessionKey: params.sessionKey,
      config: params.cfg,
      request: {
        replacements: [
          {
            entryId: target.id,
            message: {
              ...targetMessage,
              content: input.content,
            } as unknown as AgentMessage,
          },
        ],
      },
    });
    if (!rewritten.changed && rewritten.reason) {
      params.context.logGateway.warn(
        `internal chat source reply transcript rewrite failed: ${rewritten.reason}`,
      );
      return false;
    }
    const rewrittenTarget = rewritten.changed
      ? findAssistantTranscriptEntryByIdempotencyKey(
          await readSessionTranscriptIndex(input.transcriptPath),
          input.sourceReplyRunId,
        )
      : target;
    if (rewrittenTarget?.id) {
      await attachManagedOutgoingImagesToMessage({
        messageId: rewrittenTarget.id,
        blocks: input.content,
      });
    }
    return true;
  };

  const waitAndRewriteMirrorContent = async (input: {
    transcriptPath: string;
    sourceReplyRunId: string;
    content: AssistantDisplayContentBlock[];
  }): Promise<boolean> => {
    const target = await waitForAssistantTranscriptEntryByIdempotencyKey(
      input.transcriptPath,
      input.sourceReplyRunId,
    );
    if (!target) {
      params.context.logGateway.warn(
        "internal chat source reply transcript rewrite skipped: mirror not found",
      );
      return false;
    }
    return await rewriteMirrorContent(input);
  };

  return {
    async projectIfNeeded(input: { payload: ReplyPayload; agentRunStarted: boolean }) {
      if (!input.agentRunStarted || !isInternalSourceReplyPayload(input.payload)) {
        return;
      }
      const metadata = getReplyPayloadMetadata(input.payload)?.sourceReplyTranscriptMirror;
      const [displayPayload] = await normalizeWebchatReplyMediaPathsForDisplay({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        accountId: params.accountId,
        payloads: [input.payload],
      });
      if (!displayPayload) {
        return;
      }
      const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
        params.sessionKey,
      );
      const sessionId = latestEntry?.sessionId ?? params.backingSessionId ?? params.clientRunId;
      const resolvedTranscriptPath = params.resolveTranscriptPath({
        sessionId,
        storePath: latestStorePath,
        sessionFile: latestEntry?.sessionFile ?? params.initialSessionFile,
        agentId: params.agentId,
      });
      const mediaLocalRoots = appendLocalMediaParentRoots(
        getAgentScopedMediaLocalRoots(params.cfg, params.agentId),
        resolvedTranscriptPath ? [resolvedTranscriptPath] : undefined,
      );
      const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
        sessionKey: params.sessionKey,
        payloads: [displayPayload],
        managedImageLocalRoots: mediaLocalRoots,
        includeSensitiveMedia: displayPayload.sensitiveMedia !== true,
        onLocalAudioAccessDenied: (message) => {
          params.context.logGateway.warn(
            `internal chat audio embedding denied local path: ${message}`,
          );
        },
        onManagedImagePrepareError: (message) => {
          params.context.logGateway.warn(
            `internal chat image embedding skipped attachment: ${message}`,
          );
        },
      });
      // Sensitive media may render in the live chat event, but must not be
      // copied into durable transcript mirrors below.
      const mediaMessage = await buildInternalChatAssistantMediaMessage([displayPayload], {
        localRoots: mediaLocalRoots,
        onLocalAudioAccessDenied: (message) => {
          params.context.logGateway.warn(
            `internal chat audio embedding denied local path: ${message}`,
          );
        },
      });
      const broadcastAssistantContent = hasAssistantDisplayMediaContent(assistantContent)
        ? assistantContent
        : hasAssistantDisplayMediaContent(mediaMessage?.content)
          ? mediaMessage?.content
          : assistantContent;
      const transcriptReplyText = params.buildTranscriptReplyText([displayPayload]);
      const richSourceReplyFallback = buildRichSourceReplyFallbackText(displayPayload);
      const mediaFallbackText = buildAssistantMediaFallbackText(broadcastAssistantContent);
      const displayReply = mergeSourceReplyDisplayText(
        extractAssistantDisplayTextFromContent(assistantContent) ??
          mediaMessage?.transcriptText ??
          mediaFallbackText ??
          transcriptReplyText,
        richSourceReplyFallback,
      );
      if (!displayReply && !broadcastAssistantContent?.length) {
        return;
      }
      const sourceReplyIndex = projectionCount;
      projectionCount += 1;
      // The model run may already have emitted its final event; use a distinct
      // run id so TUI/WebChat clients do not discard this visible source reply.
      const sourceReplyRunId =
        metadata?.idempotencyKey?.trim() ||
        `${params.clientRunId}:internal-source-reply:${sourceReplyIndex}`;
      const broadcastContent = applyDisplayTextToAssistantContent(
        broadcastAssistantContent,
        displayReply,
      );
      const transcriptContentSource =
        displayPayload.sensitiveMedia === true ? assistantContent : broadcastAssistantContent;
      const transcriptContent = applyDisplayTextToAssistantContent(
        transcriptContentSource,
        displayReply,
      );
      const metadataHasDurableMirrorContent = sourceReplyMirrorHasDurableContent(metadata);
      const needsMirrorUpgrade = sourceReplyContentNeedsMirrorUpgrade({
        metadata,
        displayPayload,
        displayReply,
        content: transcriptContent,
        richSourceReplyFallback,
      });
      let durableMirrorFound = false;
      let managedOutgoingImagesAttached = false;
      if (
        metadataHasDurableMirrorContent &&
        needsMirrorUpgrade &&
        transcriptContent?.length &&
        resolvedTranscriptPath
      ) {
        durableMirrorFound = await rewriteMirrorContent({
          transcriptPath: resolvedTranscriptPath,
          sourceReplyRunId,
          content: transcriptContent,
        });
        if (!durableMirrorFound) {
          durableMirrorFound = await waitAndRewriteMirrorContent({
            transcriptPath: resolvedTranscriptPath,
            sourceReplyRunId,
            content: transcriptContent,
          });
        }
      }
      if (durableMirrorFound) {
        managedOutgoingImagesAttached = true;
      }
      const broadcastContentForMessage = buildBroadcastContentForManagedImageState({
        content: broadcastContent,
        displayText: displayReply,
        managedOutgoingImagesAttached,
      });
      let message: Record<string, unknown> = {
        role: "assistant",
        ...(broadcastContentForMessage?.length ? { content: broadcastContentForMessage } : {}),
        ...(displayReply ? { text: displayReply } : {}),
        timestamp: Date.now(),
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
      };
      if (displayReply && !metadataHasDurableMirrorContent) {
        const appended = await params.appendAssistantTranscriptMessage({
          message: displayReply,
          ...(transcriptContent?.length ? { content: transcriptContent } : {}),
          sessionId,
          storePath: latestStorePath,
          sessionFile: latestEntry?.sessionFile,
          agentId: params.agentId,
          createIfMissing: true,
          idempotencyKey: sourceReplyRunId,
          cfg: params.cfg,
        });
        if (appended.ok && appended.message) {
          if (appended.messageId && transcriptContent?.length) {
            await attachManagedOutgoingImagesToMessage({
              messageId: appended.messageId,
              blocks: transcriptContent,
            });
            managedOutgoingImagesAttached = true;
          }
          const appendedBroadcastContent = buildBroadcastContentForManagedImageState({
            content: broadcastContent,
            displayText: displayReply,
            managedOutgoingImagesAttached,
          });
          message = appendedBroadcastContent?.length
            ? { ...appended.message, content: appendedBroadcastContent }
            : appended.message;
        } else {
          params.context.logGateway.warn(
            `internal chat source reply transcript append failed: ${appended.error ?? "unknown error"}`,
          );
        }
      }
      params.broadcastFinal({
        runId: sourceReplyRunId,
        sessionKey: params.sessionKey,
        message,
      });
    },
  };
}
