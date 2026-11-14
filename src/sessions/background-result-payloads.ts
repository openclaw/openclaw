// Turns delivered reply payloads into one background result row in a conversation.
import { mediaKindFromMime } from "@openclaw/media-core/constants";
import { isAudioFileName, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { resolveMirroredTranscriptText } from "../config/sessions/transcript-mirror.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  attachManagedOutgoingMediaToMessage,
  removeManagedOutgoingMediaBlocks,
} from "../gateway/managed-image-attachments.js";
import {
  buildAssistantReplyContent,
  hasAssistantDisplayMediaContent,
  hasManagedOutgoingAssistantContent,
} from "../gateway/server-methods/chat-assistant-content.js";
import {
  createStructuredOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
  resolveOutboundPayloadMirrorText,
} from "../infra/outbound/payloads.js";
import { collectReplyMediaEntries } from "../infra/outbound/reply-media-entries.js";
import { hasReplyChannelData } from "../interactive/payload.js";
import { logWarn } from "../logger.js";
import { getAgentScopedMediaLocalRootsForSources } from "../media/local-roots.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import {
  commitBackgroundResultToSession,
  type BackgroundSessionResultProvenance,
} from "./background-session-result.js";

/** Outcome of a payload commit; `skipped` results were intentionally not written. */
export type BackgroundPayloadsCommit =
  | { ok: true; skipped?: boolean; diagnostics?: string }
  | { ok: false; reason: string };

/** Inputs for committing delivered payloads into one conversation generation. */
export type BackgroundPayloadsCommitParams = {
  agentId: string;
  sessionKey: string;
  expectedGeneration: { sessionId: string; lifecycleRevision: string | undefined };
  /** The payloads that were shown; the stored row is their transcript projection. */
  payloads: readonly ReplyPayload[];
  idempotencyKey: string;
  provenance?: BackgroundSessionResultProvenance;
  config: OpenClawConfig;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};

/**
 * Commits shown payloads as one model-visible row with display media.
 * Native-only payloads have no honest text and are skipped with a diagnostic.
 */
export async function commitBackgroundPayloadsToSession(
  params: BackgroundPayloadsCommitParams,
): Promise<BackgroundPayloadsCommit> {
  const payloads = params.payloads.map(toTranscriptPayload);
  const mirror = projectOutboundPayloadPlanForMirror(createStructuredOutboundPayloadPlan(payloads));
  const text = resolveMirroredTranscriptText(mirror);
  if (!text) {
    return payloads.some((payload) => hasReplyChannelData(payload.channelData))
      ? { ok: true, skipped: true, diagnostics: "native-only payload not added to conversation" }
      : { ok: false, reason: "background result has no visible payload" };
  }
  // Prepared managed media is released unless the committed row takes ownership of it.
  let preparedContent: Record<string, unknown>[] | undefined;
  let appended = false;
  try {
    return await commitBackgroundResultToSession({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      expectedGeneration: params.expectedGeneration,
      text,
      prepareDisplayContent: async () => {
        preparedContent = await buildResultDisplayContent({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          config: params.config,
          payloads,
          mediaSources: mirror.mediaUrls,
        });
        return hasAssistantDisplayMediaContent(preparedContent) ? preparedContent : undefined;
      },
      idempotencyKey: params.idempotencyKey,
      provenance: params.provenance,
      config: params.config,
      signal: params.signal,
      assertCurrent: params.assertCurrent,
      onMessageCommitted: (result, acceptCompletion) => {
        // Promote before publication; retries own the original committed blocks.
        appended = result.appended;
        const blocks = readAssistantDisplayContent(result.message);
        if (hasManagedOutgoingAssistantContent(blocks)) {
          acceptCompletion(async () => {
            if (
              !(await attachManagedOutgoingMediaToMessage({ messageId: result.messageId, blocks }))
            ) {
              throw new Error("Result media ownership could not be persisted");
            }
          });
        }
      },
    });
  } finally {
    if (!appended && preparedContent) {
      await removeManagedOutgoingMediaBlocks({ blocks: preparedContent, messageId: null });
    }
  }
}

// Spoken payloads are stored as their text; the audio file itself is not history.
function toTranscriptPayload(payload: ReplyPayload): ReplyPayload {
  const spokenText = normalizeOptionalString(payload.spokenText);
  if (!spokenText) {
    return payload;
  }
  return copyReplyPayloadMetadata(payload, {
    ...payload,
    text: spokenText,
    spokenText: undefined,
    audioAsVoice: undefined,
    mediaUrl: undefined,
    mediaUrls: [payload.mediaUrl, ...(payload.mediaUrls ?? [])].filter(
      (url): url is string => Boolean(url) && !isAudioFileName(url),
    ),
  });
}

// Builds display blocks for delivered media. Images become managed media;
// documents are recorded as named references because delivery confirms the
// reference, not permission to ingest the local file.
async function buildResultDisplayContent(params: {
  agentId: string;
  sessionKey: string;
  config: OpenClawConfig;
  payloads: readonly ReplyPayload[];
  mediaSources: readonly string[];
}): Promise<Record<string, unknown>[]> {
  const documentReferences = new Map<string, Record<string, unknown>>();
  const displayPayloads = params.payloads.map((payload) => {
    const documentNames: string[] = [];
    // Split each payload's media into embeddable entries and document references.
    const media = collectReplyMediaEntries(payload).filter(({ url, attachment }) => {
      const mimeType = attachment?.mimeType ?? mimeTypeFromFilePath(url);
      if (payload.sensitiveMedia === true || mediaKindFromMime(mimeType) !== "document") {
        return true;
      }
      if (!documentReferences.has(url)) {
        documentNames.push(attachment?.name || url);
        documentReferences.set(url, {
          type: "attachment",
          attachment: {
            kind: "document",
            label: resolveMirroredTranscriptText({ mediaUrls: [attachment?.name || url] }),
            mimeType,
          },
        });
      }
      return false;
    });
    const payloadText = resolveOutboundPayloadMirrorText(payload);
    return copyReplyPayloadMetadata(payload, {
      ...payload,
      text: documentNames.length
        ? (resolveMirroredTranscriptText({ text: payloadText, mediaUrls: documentNames }) ??
          undefined)
        : payloadText,
      mediaUrl: undefined,
      mediaUrls: media.map(({ url }) => url),
      attachments: media.map(({ attachment }) => attachment ?? {}),
    });
  });
  const { assistantContent } = await buildAssistantReplyContent({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    payloads: displayPayloads,
    managedMediaLocalRoots: getAgentScopedMediaLocalRootsForSources({
      cfg: params.config,
      agentId: params.agentId,
      mediaSources: [...params.mediaSources],
    }),
    includeSensitiveMedia: false,
    onManagedMediaPrepareError: (message) => logWarn(`Result media embedding skipped: ${message}`),
  });
  return [...(assistantContent ?? []), ...documentReferences.values()];
}
