import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { rewriteTranscriptEntriesInSessionFile } from "../../agents/pi-embedded-runner/transcript-rewrite.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
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
  hasManagedOutgoingAssistantContent,
  replaceAssistantContentTextBlocks,
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

async function findSourceReplyTranscriptMirrorByIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<{ messageId: string; message: Record<string, unknown> } | null> {
  const target = findAssistantTranscriptEntryByIdempotencyKey(
    await readSessionTranscriptIndex(transcriptPath),
    idempotencyKey,
  );
  const message = target?.record.message as Record<string, unknown> | undefined;
  if (
    !target?.id ||
    !message ||
    message.provider !== "openclaw" ||
    message.model !== "delivery-mirror"
  ) {
    return null;
  }
  return { messageId: target.id, message };
}

function extractAssistantTranscriptText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? ((block as { text: string }).text.trim() ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

async function findSourceReplyTranscriptMirrorByMetadata(params: {
  transcriptPath: string;
  idempotencyKey: string;
  metadata: SourceReplyTranscriptMirrorMetadata;
}): Promise<{ messageId: string; message: Record<string, unknown> } | null> {
  const byIdempotencyKey = await findSourceReplyTranscriptMirrorByIdempotencyKey(
    params.transcriptPath,
    params.idempotencyKey,
  );
  if (byIdempotencyKey) {
    return byIdempotencyKey;
  }
  const expectedText = resolveMirroredTranscriptText({
    text: params.metadata?.text,
    mediaUrls: params.metadata?.mediaUrls,
  });
  if (!expectedText) {
    return null;
  }
  const index = await readSessionTranscriptIndex(params.transcriptPath);
  const target = index?.entries.toReversed().find((entry) => {
    const message = entry.record.message as Record<string, unknown> | undefined;
    return (
      typeof entry.id === "string" &&
      entry.id.trim().length > 0 &&
      message?.role === "assistant" &&
      message.provider === "openclaw" &&
      message.model === "delivery-mirror" &&
      extractAssistantTranscriptText(message) === expectedText
    );
  });
  const message = target?.record.message as Record<string, unknown> | undefined;
  if (!target?.id || !message) {
    return null;
  }
  return { messageId: target.id, message };
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
    allowedRewriteSuffixEntryIds?: readonly string[];
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
        allowedRewriteSuffixEntryIds: input.allowedRewriteSuffixEntryIds?.length
          ? [...input.allowedRewriteSuffixEntryIds]
          : [target.id],
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
    allowedRewriteSuffixEntryIds?: readonly string[];
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

  const findAllowedSourceReplyMirrorIds = async (input: {
    transcriptPath: string;
    payloads: readonly ReplyPayload[];
  }): Promise<string[]> => {
    const index = await readSessionTranscriptIndex(input.transcriptPath);
    const allowedIds = new Set<string>();
    for (const payload of input.payloads) {
      const metadata = getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror;
      const idempotencyKey = metadata?.idempotencyKey?.trim();
      if (!idempotencyKey) {
        continue;
      }
      const target = findAssistantTranscriptEntryByIdempotencyKey(index, idempotencyKey);
      if (typeof target?.id === "string" && target.id.trim()) {
        allowedIds.add(target.id);
      }
    }
    return [...allowedIds];
  };

  const projectExplicitSourceReply = async (input: {
    payload: ReplyPayload;
    sourceReplyPayloads: readonly ReplyPayload[];
  }): Promise<boolean> => {
    const { payload } = input;
    if (!isInternalSourceReplyPayload(payload)) {
      return false;
    }
    const metadata = getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror;
    const [displayPayload] = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      accountId: params.accountId,
      payloads: [payload],
    });
    if (!displayPayload) {
      return false;
    }
    const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(params.sessionKey);
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
      return false;
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
    const allowedRewriteSuffixEntryIds = resolvedTranscriptPath
      ? await findAllowedSourceReplyMirrorIds({
          transcriptPath: resolvedTranscriptPath,
          payloads: input.sourceReplyPayloads,
        })
      : [];
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
        allowedRewriteSuffixEntryIds,
      });
      if (!durableMirrorFound) {
        durableMirrorFound = await waitAndRewriteMirrorContent({
          transcriptPath: resolvedTranscriptPath,
          sourceReplyRunId,
          content: transcriptContent,
          allowedRewriteSuffixEntryIds,
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
    return true;
  };

  const projectAggregatedSourceReplies = async (
    sourceReplyPayloads: ReplyPayload[],
  ): Promise<boolean> => {
    if (sourceReplyPayloads.length === 0) {
      return false;
    }
    const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      accountId: params.accountId,
      payloads: sourceReplyPayloads,
    });
    const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(params.sessionKey);
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
    const buildReplyAssistantContent = async (
      payloads: typeof finalPayloads,
    ): Promise<AssistantDisplayContentBlock[] | undefined> =>
      await buildAssistantDisplayContentFromReplyPayloads({
        sessionKey: params.sessionKey,
        payloads,
        managedImageLocalRoots: mediaLocalRoots,
        includeSensitiveMedia: false,
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
    const buildReplyMediaMessage = async (payloads: typeof finalPayloads) =>
      await buildInternalChatAssistantMediaMessage(payloads, {
        localRoots: mediaLocalRoots,
        onLocalAudioAccessDenied: (message) => {
          params.context.logGateway.warn(
            `internal chat audio embedding denied local path: ${message}`,
          );
        },
      });
    const combinedAssistantContent =
      sourceReplyPayloads.length === 1
        ? await buildReplyAssistantContent(finalPayloads)
        : undefined;
    const combinedMediaMessage =
      sourceReplyPayloads.length === 1 ? await buildReplyMediaMessage(finalPayloads) : undefined;
    type SourceReplyContentState = {
      broadcastContent: AssistantDisplayContentBlock[];
      persistedContent: AssistantDisplayContentBlock[];
      hasManagedOutgoingContent: boolean;
      backedManagedOutgoingContent: boolean;
    };
    const sourceReplyContentStates: SourceReplyContentState[] = [];
    const sourceReplyBroadcastContent: AssistantDisplayContentBlock[] = [];
    for (const [replyIndex] of sourceReplyPayloads.entries()) {
      const finalPayload = finalPayloads[replyIndex];
      if (!finalPayload) {
        continue;
      }
      const replyAssistantContent =
        sourceReplyPayloads.length === 1
          ? combinedAssistantContent
          : await buildReplyAssistantContent([finalPayload]);
      const replyMediaMessage =
        sourceReplyPayloads.length === 1
          ? combinedMediaMessage
          : await buildReplyMediaMessage([finalPayload]);
      const replyBroadcastContent = hasAssistantDisplayMediaContent(replyAssistantContent)
        ? replyAssistantContent
        : hasAssistantDisplayMediaContent(replyMediaMessage?.content)
          ? replyMediaMessage?.content
          : replyAssistantContent;
      const persistedContent = replaceAssistantContentTextBlocks(
        replyAssistantContent,
        replyMediaMessage ?? null,
      );
      const state: SourceReplyContentState = {
        broadcastContent: replyBroadcastContent ? [...replyBroadcastContent] : [],
        persistedContent: persistedContent ? [...persistedContent] : [],
        hasManagedOutgoingContent: hasManagedOutgoingAssistantContent(persistedContent),
        backedManagedOutgoingContent: false,
      };
      sourceReplyContentStates[replyIndex] = state;
      if (state.broadcastContent.length > 0) {
        sourceReplyBroadcastContent.push(...state.broadcastContent);
      }
    }

    const displayReply =
      extractAssistantDisplayTextFromContent(sourceReplyBroadcastContent) ??
      params.buildTranscriptReplyText(finalPayloads);
    if (!sourceReplyBroadcastContent.length && !displayReply) {
      return false;
    }

    const sourceReplyPersistenceRequests: Array<{
      idempotencyKey: string;
      metadata: SourceReplyTranscriptMirrorMetadata;
      state: SourceReplyContentState;
    }> = [];
    for (const [replyIndex, sourceReplyPayload] of sourceReplyPayloads.entries()) {
      const state = sourceReplyContentStates[replyIndex];
      if (!state || !hasAssistantDisplayMediaContent(state.persistedContent)) {
        continue;
      }
      const mirrorMetadata =
        getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
      const mirrorIdempotencyKey = mirrorMetadata?.idempotencyKey;
      if (
        typeof mirrorIdempotencyKey !== "string" ||
        mirrorIdempotencyKey.trim().length === 0 ||
        !mirrorMetadata
      ) {
        continue;
      }
      if (!state.hasManagedOutgoingContent) {
        state.backedManagedOutgoingContent = true;
      }
      sourceReplyPersistenceRequests.push({
        idempotencyKey: mirrorIdempotencyKey,
        metadata: mirrorMetadata,
        state,
      });
    }

    const attachSourceReplyManagedImages = async (input: {
      messageId?: string;
      request: (typeof sourceReplyPersistenceRequests)[number];
    }) => {
      if (!input.request.state.hasManagedOutgoingContent) {
        input.request.state.backedManagedOutgoingContent = true;
        return;
      }
      if (!input.messageId) {
        return;
      }
      await attachManagedOutgoingImagesToMessage({
        messageId: input.messageId,
        blocks: input.request.state.persistedContent,
      });
      input.request.state.backedManagedOutgoingContent = true;
    };

    if (resolvedTranscriptPath && sourceReplyPersistenceRequests.length > 0) {
      const allowedSourceReplyMirrorIds = new Set<string>();
      for (const [replyIndex, sourceReplyPayload] of sourceReplyPayloads.entries()) {
        if (!sourceReplyContentStates[replyIndex]) {
          continue;
        }
        const mirrorMetadata =
          getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
        const mirrorIdempotencyKey = mirrorMetadata?.idempotencyKey;
        if (
          typeof mirrorIdempotencyKey !== "string" ||
          mirrorIdempotencyKey.trim().length === 0 ||
          !mirrorMetadata
        ) {
          continue;
        }
        const target = await findSourceReplyTranscriptMirrorByMetadata({
          transcriptPath: resolvedTranscriptPath,
          idempotencyKey: mirrorIdempotencyKey,
          metadata: mirrorMetadata,
        });
        if (target) {
          allowedSourceReplyMirrorIds.add(target.messageId);
        }
      }
      const rewriteTargets: Array<{
        request: (typeof sourceReplyPersistenceRequests)[number];
        messageId: string;
        message: Record<string, unknown>;
      }> = [];
      for (const request of sourceReplyPersistenceRequests) {
        const target = await findSourceReplyTranscriptMirrorByMetadata({
          transcriptPath: resolvedTranscriptPath,
          idempotencyKey: request.idempotencyKey,
          metadata: request.metadata,
        });
        if (target) {
          rewriteTargets.push({ request, ...target });
        }
      }

      if (rewriteTargets.length > 0) {
        const rewriteTargetIds = new Set(rewriteTargets.map((target) => target.messageId));
        const rewriteIndex = await readSessionTranscriptIndex(resolvedTranscriptPath);
        const firstRewriteEntryIndex =
          rewriteIndex?.entries.findIndex(
            (entry) => typeof entry.id === "string" && rewriteTargetIds.has(entry.id),
          ) ?? -1;
        const canRewriteSourceReplyMirrors =
          firstRewriteEntryIndex >= 0 &&
          rewriteIndex?.entries
            .slice(firstRewriteEntryIndex)
            .every(
              (entry) => typeof entry.id !== "string" || allowedSourceReplyMirrorIds.has(entry.id),
            ) === true;
        if (canRewriteSourceReplyMirrors) {
          const result = await rewriteTranscriptEntriesInSessionFile({
            sessionFile: resolvedTranscriptPath,
            sessionKey: params.sessionKey,
            config: params.cfg,
            request: {
              allowedRewriteSuffixEntryIds: [...allowedSourceReplyMirrorIds],
              replacements: rewriteTargets.map((target) => ({
                entryId: target.messageId,
                message: {
                  ...(target.message as unknown as AgentMessage),
                  idempotencyKey: target.request.idempotencyKey,
                  content: target.request.state.persistedContent,
                } as unknown as AgentMessage,
              })),
            },
          });
          if (result.changed) {
            for (const target of rewriteTargets) {
              const rewritten = await findSourceReplyTranscriptMirrorByIdempotencyKey(
                resolvedTranscriptPath,
                target.request.idempotencyKey,
              );
              await attachSourceReplyManagedImages({
                messageId: rewritten?.messageId,
                request: target.request,
              });
            }
          }
        }
      }
    }

    const sourceReplyContent = sourceReplyContentStates
      .flatMap((state) => {
        if (state.hasManagedOutgoingContent && !state.backedManagedOutgoingContent) {
          const stripped = stripManagedOutgoingAssistantContentBlocks(state.broadcastContent);
          return stripped?.length
            ? stripped
            : [{ type: "text", text: "Media reply could not be displayed." }];
        }
        return state.broadcastContent;
      })
      .filter((block): block is AssistantDisplayContentBlock => Boolean(block));
    const sourceReplyTextFromContent = extractAssistantDisplayTextFromContent(sourceReplyContent);
    const sourceReplyText =
      sourceReplyTextFromContent ?? (sourceReplyContent.length === 0 ? displayReply : undefined);
    const message = {
      role: "assistant",
      ...(sourceReplyContent?.length
        ? { content: sourceReplyContent }
        : sourceReplyText
          ? { content: [{ type: "text", text: sourceReplyText }] }
          : {}),
      ...(sourceReplyText ? { text: sourceReplyText } : {}),
      timestamp: Date.now(),
      stopReason: "stop",
      usage: { input: 0, output: 0, totalTokens: 0 },
    };
    params.broadcastFinal({
      runId: params.clientRunId,
      sessionKey: params.sessionKey,
      message,
    });
    return true;
  };

  return {
    async projectReplies(input: {
      deliveredReplies: Array<{ payload: ReplyPayload; kind: "block" | "final" }>;
      agentRunStarted: boolean;
    }): Promise<boolean> {
      if (!input.agentRunStarted) {
        return false;
      }
      const sourceReplyPayloads = input.deliveredReplies
        .filter((entry) => entry.kind === "final")
        .map((entry) => entry.payload)
        .filter(isInternalSourceReplyPayload);
      if (sourceReplyPayloads.length === 0) {
        return false;
      }
      let broadcasted = false;
      const aggregatedPayloads: ReplyPayload[] = [];
      for (const payload of sourceReplyPayloads) {
        if (getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true) {
          broadcasted =
            (await projectExplicitSourceReply({
              payload,
              sourceReplyPayloads,
            })) || broadcasted;
        } else {
          aggregatedPayloads.push(payload);
        }
      }
      broadcasted = (await projectAggregatedSourceReplies(aggregatedPayloads)) || broadcasted;
      return broadcasted;
    },
  };
}
