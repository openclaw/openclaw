import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import {
  readActiveTranscriptEntryAnchor,
  rewriteTranscriptMessageAtAnchor,
} from "../../config/sessions/session-accessor.js";
import {
  captureOwnedTranscriptWriteAssertion,
  runWithOwnedSessionTranscriptWrite,
  SessionTranscriptWriterClaimReboundError,
} from "../../config/sessions/transcript-write-context.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import {
  onInternalSessionTranscriptUpdate,
  readSessionTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../../shared/assistant-display-content.js";
import { withChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { readAssistantTextBlocksForPhase } from "../../shared/chat-message-content.js";
import {
  attachManagedOutgoingMediaToMessage,
  buildManagedMediaFailureBlock,
  createManagedOutgoingMediaBlocks,
  prepareOutgoingMediaFromReplyPayload,
  removeManagedOutgoingMediaBlocks,
} from "../managed-image-attachments.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import type { AssistantDisplayContentBlock } from "./chat-assistant-content.js";
import {
  captureWebchatReplyMediaScope,
  getWebchatReplyMediaLocalRoots,
  normalizeWebchatReplyMediaPathsForDisplay,
  type WebchatReplyMediaRequesterContext,
} from "./chat-reply-media.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { publishAssistantTranscriptRewrite } from "./chat-transcript-persistence.js";
import type { GatewayRequestContext } from "./types.js";

/** Materialize committed progress attachments within the same admitted webchat run. */
export function observeChatSendCommentaryMedia(params: {
  requesterContext?: WebchatReplyMediaRequesterContext;
  session: Pick<PreparedChatSendSession, "agentId" | "cfg" | "sessionKey" | "sessionLoadOptions">;
  accountId: string | undefined;
  getRunId: () => string;
  isCurrent: () => boolean;
  abortSignal?: AbortSignal;
  logGateway: GatewayRequestContext["logGateway"];
}) {
  const { session } = params;
  const seen = new Set<string>();
  let pending = Promise.resolve();
  let lastRewrite: { sessionId: string; generation: string } | undefined;
  const reportPreparationFailure = (error: unknown) => {
    if (!(error instanceof SessionTranscriptWriterClaimReboundError)) {
      params.logGateway.warn(`webchat commentary media preparation failed: ${formatForLog(error)}`);
    }
  };
  const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
    const message = asOptionalRecord(update.message);
    const target = update.target;
    const messageId = update.messageId;
    if (
      !target ||
      target.sessionKey !== session.sessionKey ||
      target.agentId !== session.agentId ||
      !messageId ||
      message?.role !== "assistant" ||
      readSessionTranscriptRunId(message) !== params.getRunId() ||
      !params.isCurrent() ||
      !Array.isArray(message.content) ||
      Array.isArray(message[ASSISTANT_DISPLAY_CONTENT_FIELD])
    ) {
      return;
    }
    const delivery = asOptionalRecord(message.openclawDelivery);
    const authoredMedia = new Set(
      Array.isArray(delivery?.mediaUrls)
        ? delivery.mediaUrls.filter((url): url is string => typeof url === "string")
        : [],
    );
    // Only pre-hook authored references carry delivery intent; hook-added text stays prose.
    const commentaryBlocks = new Set<unknown>(
      readAssistantTextBlocksForPhase(message, "commentary"),
    );
    const commentaryIndexes = new Set<number>();
    const mediaUrls = Array.from(
      new Set(
        message.content.flatMap((value, index) => {
          const block = asOptionalRecord(value);
          if (commentaryBlocks.has(value)) {
            commentaryIndexes.add(index);
          }
          return block && commentaryIndexes.has(index) && typeof block.text === "string"
            ? (splitMediaFromOutput(block.text).mediaUrls ?? []).filter((url) =>
                authoredMedia.has(url),
              )
            : [];
        }),
      ),
    );
    const key = `${target.sessionId}:${messageId}`;
    if (mediaUrls.length === 0 || seen.has(key)) {
      return;
    }
    seen.add(key);
    const runId = params.getRunId();
    const current = loadSessionEntry(session.sessionKey, session.sessionLoadOptions);
    if (current.entry?.sessionId !== target.sessionId) {
      return;
    }
    const lifecycleRevision = current.entry.lifecycleRevision;
    const scope = { ...target, storePath: current.storePath };
    const assertOwned = captureOwnedTranscriptWriteAssertion(scope);
    const assertCurrent = () => {
      assertOwned();
      const latest = loadSessionEntry(session.sessionKey, session.sessionLoadOptions);
      if (
        !params.isCurrent() ||
        params.abortSignal?.aborted ||
        params.getRunId() !== runId ||
        latest.entry?.sessionId !== scope.sessionId ||
        latest.entry.lifecycleRevision !== lifecycleRevision
      ) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
    };
    const originalContent = structuredClone(message.content);
    const previous = pending;
    // Register before the committed-event callback returns so attempt cleanup joins
    // the media work before closing its captured writer authority.
    pending = runWithOwnedSessionTranscriptWrite({ sessionTarget: scope }, () =>
      previous
        .then(async () => {
          assertCurrent();
          let anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: messageId });
          if (!anchor) {
            const { waitForSessionTranscriptProjection } =
              await import("../../config/sessions/session-transcript-reconcile.js");
            await waitForSessionTranscriptProjection(scope);
            assertCurrent();
            anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: messageId });
          }
          if (!anchor) {
            return;
          }
          const managedMedia = new Map<string, AssistantDisplayContentBlock[]>();
          let committed = false;
          try {
            const mediaScope = captureWebchatReplyMediaScope({
              requesterContext: params.requesterContext,
              cfg: session.cfg,
              sessionKey: scope.sessionKey,
              agentId: scope.agentId,
              sessionLoadOptions: session.sessionLoadOptions,
              accountId: params.accountId,
              assertCurrent,
            });
            await withChannelReadAuthority(mediaScope.assertCurrent, async () => {
              const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
                ...mediaScope,
                payloads: mediaUrls.map((url) => ({ mediaUrls: [url] })),
              });
              assertCurrent();
              for (const [index, payload] of payloads.entries()) {
                // History ownership starts after the rewrite; GC can run during preparation.
                const blocks = await createManagedOutgoingMediaBlocks({
                  sessionKey: scope.sessionKey,
                  agentId: scope.agentId,
                  items: prepareOutgoingMediaFromReplyPayload(payload),
                  localRoots: getWebchatReplyMediaLocalRoots({
                    ...mediaScope,
                  }),
                  continueOnPrepareError: true,
                  assertCurrent: mediaScope.assertCurrent,
                  abortSignal: params.abortSignal,
                });
                blocks.push(
                  ...(getReplyPayloadMetadata(payload)?.assistantMediaFailures ?? []).map(
                    buildManagedMediaFailureBlock,
                  ),
                );
                managedMedia.set(mediaUrls[index]!, blocks);
                assertCurrent();
              }
            });
            const { waitForSessionTranscriptProjection } =
              await import("../../config/sessions/session-transcript-reconcile.js");
            await waitForSessionTranscriptProjection(scope);
            assertCurrent();
            const rewritten = await rewriteTranscriptMessageAtAnchor(anchor, (value) => {
              assertCurrent();
              const active = readActiveTranscriptEntryAnchor({ ...scope, entryId: messageId });
              const currentMessage = asOptionalRecord(value);
              if (
                active?.rawSeq !== anchor.rawSeq ||
                !currentMessage ||
                readSessionTranscriptRunId(currentMessage) !== runId ||
                !isDeepStrictEqual(currentMessage.content, originalContent)
              ) {
                return undefined;
              }
              const displayContent: unknown[] = [];
              for (const [index, raw] of originalContent.entries()) {
                const block = asOptionalRecord(raw);
                if (!block || !commentaryIndexes.has(index) || typeof block.text !== "string") {
                  displayContent.push(raw);
                  continue;
                }
                const parsed = splitMediaFromOutput(block.text);
                const segments = parsed.segments ?? [{ type: "text" as const, text: block.text }];
                displayContent.push({ ...block, text: "" });
                for (const segment of segments) {
                  if (segment.type === "text") {
                    displayContent.push({ ...block, text: segment.text });
                  } else {
                    displayContent.push(
                      ...(managedMedia.get(segment.url) ?? [
                        { ...block, text: `MEDIA:${segment.url}` },
                      ]),
                    );
                  }
                }
              }
              return { ...currentMessage, [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent };
            });
            if (rewritten) {
              // Publication failures must not discard originals already referenced by history.
              committed = true;
              lastRewrite = { sessionId: scope.sessionId, generation: rewritten.generation };
              // Settle the authorized commit even if the run becomes stale after the rewrite.
              const mediaBlocks = [...managedMedia.values()]
                .flat()
                .filter(
                  (block) =>
                    block.type === "image" ||
                    block.type === "audio" ||
                    block.type === "video" ||
                    block.type === "attachment",
                );
              if (
                mediaBlocks.length > 0 &&
                !attachManagedOutgoingMediaToMessage({ messageId, blocks: mediaBlocks })
              ) {
                throw new Error("Webchat commentary media ownership could not be persisted");
              }
              await publishAssistantTranscriptRewrite({ scope, rewritten: [{ messageId }] });
            }
          } finally {
            if (!committed) {
              await removeManagedOutgoingMediaBlocks({
                blocks: [...managedMedia.values()].flat(),
                messageId: null,
              });
            }
          }
        })
        .catch(reportPreparationFailure),
    ).catch(reportPreparationFailure);
  });
  return {
    async close() {
      unsubscribe();
      await pending;
      return lastRewrite;
    },
  };
}
