import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionActor,
} from "../../config/sessions/session-incognito-binding.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../../config/sessions/session-message-rewrite.js";
import { readActiveTranscriptEntryAnchorAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import {
  recordAssistantManagedMediaUrls,
  type PrepareAssistantTranscriptMessage,
} from "../../config/sessions/transcript-assistant-delivery.js";
import {
  captureOwnedTranscriptWriteAssertion,
  runWithOwnedSessionTranscriptWrite,
  SessionTranscriptWriterClaimReboundError,
} from "../../config/sessions/transcript-write-context.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import {
  onInternalSessionTranscriptUpdate,
  readSessionTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../../shared/assistant-display-content.js";
import { readAssistantTextBlocksForPhase } from "../../shared/chat-message-content.js";
import {
  rethrowIncognitoSessionError,
  IncognitoSessionMissingError,
} from "../../state/incognito-session-error.js";
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
  withPreparedWebchatReplyMedia,
  type WebchatReplyMediaRequesterContext,
} from "./chat-reply-media.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { publishAssistantTranscriptRewrite } from "./chat-transcript-persistence.js";
import type { GatewayRequestContext } from "./types.js";

type AssistantCommentaryMediaCustodyParams = {
  requesterContext?: WebchatReplyMediaRequesterContext;
  session: Pick<PreparedChatSendSession, "agentId" | "cfg" | "sessionKey" | "sessionLoadOptions">;
  accountId: string | undefined;
  getRunId: () => string;
  isCurrent: () => boolean;
  abortSignal?: AbortSignal;
  logGateway: GatewayRequestContext["logGateway"];
};
type CommentaryMediaRewrite = { sessionId: string; generation: string };

/** Own authored progress attachments while the caller retains its admitted run. */
export function createAssistantCommentaryMediaCustody(
  params: AssistantCommentaryMediaCustodyParams & {
    prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  },
) {
  const source = captureIncognitoSessionSource({
    agentId: params.session.agentId,
    sessionKey: params.session.sessionKey,
  });
  let preparingTranscript = false;
  let lastRewrite: CommentaryMediaRewrite | undefined;
  const prepareAssistantTranscriptMessage: PrepareAssistantTranscriptMessage = (
    message,
    sourceText,
  ) => {
    if (!preparingTranscript || !params.isCurrent() || params.abortSignal?.aborted || !sourceText) {
      return message;
    }
    // Delivery provenance comes from pre-hook text, never from local-file trust.
    const prepared = recordAssistantManagedMediaUrls(
      message,
      splitMediaFromOutput(sourceText).mediaUrls,
    );
    return params.prepareAssistantTranscriptMessage?.(prepared, sourceText) ?? prepared;
  };
  return {
    prepareAssistantTranscriptMessage,
    get lastRewrite() {
      return lastRewrite;
    },
    async run<T>(this: void, operation: () => Promise<T>): Promise<T> {
      if (source && "kind" in source) {
        source.assertCurrent();
        throw new IncognitoSessionMissingError();
      }
      const run = async () => {
        lastRewrite = undefined;
        preparingTranscript = true;
        const observer = observeChatSendCommentaryMedia(params);
        try {
          return await operation();
        } finally {
          preparingTranscript = false;
          lastRewrite = await observer.close();
        }
      };
      return source ? withIncognitoSessionActor(source.actor, run, source.admissionSignal) : run();
    },
  };
}

/** Materialize committed progress attachments within the same admitted Gateway run. */
function observeChatSendCommentaryMedia(params: AssistantCommentaryMediaCustodyParams) {
  const { session } = params;
  const source = captureIncognitoSessionSource({
    agentId: session.agentId,
    sessionKey: session.sessionKey,
  });
  const seen = new Set<string>();
  let pending = Promise.resolve();
  let uncertainRewrite = false;
  let lastRewrite: CommentaryMediaRewrite | undefined;
  const reportPreparationFailure = (error: unknown) => {
    rethrowIncognitoSessionError(error);
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
      uncertainRewrite ||
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
    const claim =
      source && !("kind" in source)
        ? source.actor.sessions.captureCurrent(session.sessionKey)
        : undefined;
    const readEntry = () => {
      if (!source) {
        return loadSessionEntry(session.sessionKey, session.sessionLoadOptions);
      }
      source.admissionSignal?.throwIfAborted();
      if ("kind" in source) {
        source.assertCurrent();
        return { entry: undefined, storePath: source.path };
      }
      claim?.assertCurrent();
      return {
        entry: source.actor.sessions.readSharing(session.sessionKey)?.entry,
        storePath: source.actor.path,
      };
    };
    const current = readEntry();
    if (current.entry?.sessionId !== target.sessionId) {
      return;
    }
    const lifecycleRevision = current.entry.lifecycleRevision;
    const scope = { ...target, storePath: current.storePath };
    const assertOwned = captureOwnedTranscriptWriteAssertion(scope);
    const assertLive = () => {
      assertOwned();
      if (
        uncertainRewrite ||
        !params.isCurrent() ||
        params.abortSignal?.aborted ||
        params.getRunId() !== runId
      ) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
    };
    const assertCurrent = () => {
      assertLive();
      const latest = readEntry();
      if (
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
    const prepare = () =>
      runWithOwnedSessionTranscriptWrite({ sessionTarget: scope }, () =>
        previous
          .then(async () => {
            assertCurrent();
            let anchor = await readActiveTranscriptEntryAnchorAsync({
              ...scope,
              entryId: messageId,
            });
            assertCurrent();
            if (!anchor) {
              const { waitForSessionTranscriptProjection } =
                await import("../../config/sessions/session-transcript-reconcile.js");
              await waitForSessionTranscriptProjection(scope, params.abortSignal);
              assertCurrent();
              anchor = await readActiveTranscriptEntryAnchorAsync({ ...scope, entryId: messageId });
              assertCurrent();
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
              await withPreparedWebchatReplyMedia(
                {
                  scope: mediaScope,
                  inputs: mediaUrls.map((url) => ({ kind: "raw", payload: { mediaUrls: [url] } })),
                  abortSignal: params.abortSignal,
                },
                async ({ payloads, localRoots, assertCurrent: assertMediaCurrent }) => {
                  assertCurrent();
                  for (const [index, payload] of payloads.entries()) {
                    // History ownership starts after the rewrite; GC can run during preparation.
                    const blocks = await createManagedOutgoingMediaBlocks({
                      sessionKey: scope.sessionKey,
                      agentId: scope.agentId,
                      items: prepareOutgoingMediaFromReplyPayload(payload),
                      localRoots,
                      continueOnPrepareError: true,
                      assertCurrent: assertMediaCurrent,
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
                  const { waitForSessionTranscriptProjection } =
                    await import("../../config/sessions/session-transcript-reconcile.js");
                  await waitForSessionTranscriptProjection(scope, params.abortSignal);
                  assertCurrent();
                  const rewritten = await rewritePreparedTranscriptMessageAtAnchor(
                    anchor,
                    (value) => {
                      assertLive();
                      const currentMessage = asOptionalRecord(value);
                      if (
                        !currentMessage ||
                        readSessionTranscriptRunId(currentMessage) !== runId ||
                        !isDeepStrictEqual(currentMessage.content, originalContent)
                      ) {
                        return undefined;
                      }
                      const displayContent: unknown[] = [];
                      for (const [index, raw] of originalContent.entries()) {
                        const block = asOptionalRecord(raw);
                        if (
                          !block ||
                          !commentaryIndexes.has(index) ||
                          typeof block.text !== "string"
                        ) {
                          displayContent.push(raw);
                          continue;
                        }
                        const parsed = splitMediaFromOutput(block.text);
                        const segments = parsed.segments ?? [
                          { type: "text" as const, text: block.text },
                        ];
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
                      return {
                        ...currentMessage,
                        [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent,
                      };
                    },
                    {
                      active: "sequence",
                      expectedEntry: { lifecycleRevision: lifecycleRevision ?? null },
                      assertCurrent: assertMediaCurrent,
                      assertNativeCurrent: assertCurrent,
                    },
                  );
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
                      !(await attachManagedOutgoingMediaToMessage({
                        messageId,
                        blocks: mediaBlocks,
                      }))
                    ) {
                      throw new Error("Webchat commentary media ownership could not be persisted");
                    }
                    await publishAssistantTranscriptRewrite({ scope, rewritten: [{ messageId }] });
                  }
                },
              );
            } catch (error) {
              if (hasSqliteWorkerOutcomeUnknown(error)) {
                uncertainRewrite = true;
                // The rewrite may own these bytes. Let the media owner inspect the
                // exact transcript references during reclamation instead of deleting them here.
                committed = true;
                try {
                  if (
                    !(await attachManagedOutgoingMediaToMessage({
                      messageId,
                      blocks: [...managedMedia.values()].flat(),
                    }))
                  ) {
                    throw new Error("Uncertain commentary media ownership could not be retained", {
                      cause: error,
                    });
                  }
                } catch (retentionError) {
                  throw createSqliteLifecycleAggregateError(
                    [error, retentionError],
                    "Transcript rewrite and media retention failed",
                    error,
                  );
                }
              }
              throw error;
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
    pending =
      source && !("kind" in source)
        ? withIncognitoSessionActor(source.actor, prepare, source.admissionSignal)
        : prepare();
  });
  return {
    async close() {
      unsubscribe();
      await pending;
      return lastRewrite;
    },
  };
}
