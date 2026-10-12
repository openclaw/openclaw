import {
  asOptionalObjectRecord,
  asOptionalRecord as transcriptEventRecord,
} from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import {
  publishTranscriptUpdate,
  type SessionTranscriptWriteScope,
  type TranscriptEvent,
} from "../../config/sessions/session-accessor.js";
import {
  applySessionEntryOperation,
  applySessionEntryTargetOperation,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import { rewritePreparedAssistantTranscriptMessageForRun } from "../../config/sessions/session-message-rewrite.js";
import { withPreparedTranscriptCorrection } from "../../config/sessions/session-transcript-correction.js";
import type { SessionLifecycleRevisionExpectation } from "../../config/sessions/session-transcript-turn-lifecycle.types.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import { normalizeMediaReferenceForComparison } from "../../media/media-reference-comparison.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import {
  ASSISTANT_DISPLAY_CONTENT_FIELD,
  readAssistantDisplayContent,
} from "../../shared/assistant-display-content.js";
import {
  extractAssistantPhaseText,
  readAssistantTextBlocksForPhase,
} from "../../shared/chat-message-content.js";
import {
  ABORTED_PARTIAL_PERSISTENCE_WARNING,
  abortedPartialPersistenceError,
  type AbortedPartialSnapshot,
} from "./chat-aborted-partial.js";
import {
  sanitizeAssistantDisplayText,
  type AssistantDisplayContentBlock,
} from "./chat-assistant-content.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";

type AssistantTranscriptScopeParams = {
  sessionId: string;
  storePath: string | undefined;
  sessionKey: string;
  agentId?: string;
};

type ResolvedAssistantTranscriptScope = SessionTranscriptWriteScope & { sessionId: string };

type SourceReplyTranscriptMirrorMetadata = NonNullable<
  ReturnType<typeof getReplyPayloadMetadata>
>["sourceReplyTranscriptMirror"];

export type SourceReplyContentState = {
  broadcastContent: AssistantDisplayContentBlock[];
  persistedContent: AssistantDisplayContentBlock[];
  hasManagedOutgoingContent: boolean;
  backedManagedOutgoingContent: boolean;
};

export type SourceReplyTranscriptMirror = {
  idempotencyKey: string;
  metadata: SourceReplyTranscriptMirrorMetadata;
};

export type SourceReplyTranscriptRewrite = SourceReplyTranscriptMirror & {
  state: SourceReplyContentState;
};

function mergeAssistantDisplayContent(
  modelContent: AssistantDisplayContentBlock[],
  preparedDisplayContent: AssistantDisplayContentBlock[],
  retainedCommentary: ReadonlySet<unknown>,
): AssistantDisplayContentBlock[] {
  const remainingDisplayContent = [...preparedDisplayContent];
  const content: AssistantDisplayContentBlock[] = [];
  for (const block of modelContent) {
    if (block.type !== "text" || typeof block.text !== "string" || retainedCommentary.has(block)) {
      content.push(block);
      continue;
    }
    const matchingTextIndex = remainingDisplayContent.findIndex(
      (candidate) => candidate.type === "text" && candidate.text === block.text,
    );
    if (matchingTextIndex < 0) {
      content.push(block);
      continue;
    }
    const nextTextOffset = remainingDisplayContent
      .slice(matchingTextIndex + 1)
      .findIndex((candidate) => candidate.type === "text");
    const segmentEnd =
      nextTextOffset < 0 ? remainingDisplayContent.length : matchingTextIndex + nextTextOffset + 1;
    content.push(...remainingDisplayContent.splice(0, segmentEnd));
  }
  content.push(...remainingDisplayContent);
  return content;
}

function buildAssistantDisplayRewrite(params: {
  message: Record<string, unknown>;
  displayContent: AssistantDisplayContentBlock[];
  managedMediaUrls?: readonly string[];
  retainOriginalText?: true;
}): Record<string, unknown> {
  const previousDisplay = Array.isArray(params.message[ASSISTANT_DISPLAY_CONTENT_FIELD])
    ? readAssistantDisplayContent(params.message)
    : undefined;
  const previousMedia = transcriptEventRecord(params.message.openclawDelivery)?.mediaUrls;
  const managedMediaUrls = previousDisplay
    ? [...filterStringEntries(previousMedia), ...(params.managedMediaUrls ?? [])]
    : params.managedMediaUrls;
  const prepared = applyAssistantDeliveryDirectives(
    {
      ...params.message,
      content: params.displayContent.map((block) => Object.assign({}, block)),
    },
    { managedMediaUrls },
  );
  const original =
    previousDisplay ??
    (Array.isArray(params.message.content)
      ? (params.message.content as AssistantDisplayContentBlock[])
      : []);
  const retainedCommentary = new Set<unknown>(
    previousDisplay
      ? readAssistantTextBlocksForPhase({ ...params.message, content: original }, "commentary")
      : [],
  );
  // Final delivery replaces its own media while retaining prepared progress segments.
  let inCommentary = false;
  const content: AssistantDisplayContentBlock[] = [];
  const seenText = new Set<string>();
  for (const block of original) {
    if (block.type === "text") {
      inCommentary = retainedCommentary.has(block);
    }
    if (inCommentary || block.type === "thinking" || block.type === "toolCall") {
      content.push(block);
      continue;
    }
    if (
      block.type !== "text" ||
      typeof block.text !== "string" ||
      (!params.retainOriginalText &&
        !prepared.content.some(
          (candidate) => candidate.type === "text" && candidate.text === block.text,
        ))
    ) {
      continue;
    }
    const splitText = splitMediaFromOutput(block.text).text;
    if (splitText === block.text && /\bMEDIA:/iu.test(block.text)) {
      continue;
    }
    const text = sanitizeAssistantDisplayText(splitText, {
      preserveBoundaries: true,
    });
    if (text) {
      if (text === block.text || previousDisplay) {
        content.push(text === block.text ? block : { ...block, text });
      } else {
        const { textSignature: _textSignature, ...rest } = block;
        content.push({ ...rest, text });
      }
      seenText.add(text);
    } else if (previousDisplay) {
      content.push({ ...block, text: "" });
    }
  }
  for (const block of prepared.content) {
    if (block.type === "text" && typeof block.text === "string" && !seenText.has(block.text)) {
      content.push(block);
    }
  }
  return {
    ...prepared,
    content: previousDisplay ? params.message.content : content,
    [ASSISTANT_DISPLAY_CONTENT_FIELD]: mergeAssistantDisplayContent(
      content,
      prepared.content,
      retainedCommentary,
    ),
  };
}

export function assistantTranscriptScope(
  params: AssistantTranscriptScopeParams,
): ResolvedAssistantTranscriptScope | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey || !params.sessionId.trim()) {
    return null;
  }
  return {
    sessionKey,
    sessionId: params.sessionId,
    ...(params.storePath ? { storePath: params.storePath } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  };
}

function transcriptEventId(event: TranscriptEvent): string | undefined {
  return readNonBlankString(transcriptEventRecord(event)?.id);
}

function transcriptEventMessage(event: TranscriptEvent): Record<string, unknown> | undefined {
  return transcriptEventRecord(transcriptEventRecord(event)?.message);
}

function transcriptMessageTarget(
  event: TranscriptEvent,
): { messageId: string; message: Record<string, unknown> } | null {
  const message = event ? transcriptEventMessage(event) : undefined;
  const messageId = event ? transcriptEventId(event) : undefined;
  return messageId && message ? { messageId, message } : null;
}

function findAssistantTranscriptMessageByIdempotencyKeyInEvents(
  events: readonly TranscriptEvent[],
  idempotencyKey: string,
): { messageId: string; message: Record<string, unknown> } | null {
  const trimmedIdempotencyKey = idempotencyKey.trim();
  if (!trimmedIdempotencyKey) {
    return null;
  }
  const target = events.findLast((event) => {
    const message = transcriptEventMessage(event);
    return message?.role === "assistant" && message.idempotencyKey === trimmedIdempotencyKey;
  });
  return transcriptMessageTarget(target);
}

function mediaReferenceSet(mediaUrls: readonly string[]) {
  return new Set(
    mediaUrls.map(normalizeMediaReferenceForComparison).filter((value) => value.length > 0),
  );
}

function findAssistantTranscriptMessageByIdAndMediaInEvents(
  events: readonly TranscriptEvent[],
  params: {
    messageId: string;
    mediaUrls: readonly string[];
    rejectedMediaCount: number;
  },
): { messageId: string; message: Record<string, unknown> } | null {
  const expectedMedia = mediaReferenceSet(params.mediaUrls);
  if ((expectedMedia.size === 0 && params.rejectedMediaCount === 0) || !params.messageId.trim()) {
    return null;
  }
  const target = events.find(
    (event) =>
      transcriptEventId(event) === params.messageId &&
      transcriptEventMessage(event)?.role === "assistant",
  );
  const found = transcriptMessageTarget(target);
  const text = found ? extractAssistantPhaseText(found.message) : undefined;
  if (!found || !text) {
    return null;
  }
  const parsed = splitMediaFromOutput(text);
  const actualMedia = mediaReferenceSet(parsed.mediaUrls ?? []);
  // A reply whose only directives were rejected is identified by their count.
  const exactMediaMatch =
    actualMedia.size === expectedMedia.size &&
    [...expectedMedia].every((value) => actualMedia.has(value)) &&
    (parsed.rejectedMediaCount ?? 0) === params.rejectedMediaCount;
  return exactMediaMatch ? found : null;
}

function extractAssistantTranscriptText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((value) => {
      const block = asOptionalObjectRecord(value);
      return block?.type === "text" && typeof block.text === "string" ? block.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

function findSourceReplyTranscriptMirrorByMetadataInEvents(
  params: SourceReplyTranscriptMirror & { events: readonly TranscriptEvent[] },
): { messageId: string; message: Record<string, unknown> } | null {
  const byIdempotencyKey = findAssistantTranscriptMessageByIdempotencyKeyInEvents(
    params.events,
    params.idempotencyKey,
  );
  if (
    byIdempotencyKey?.message.provider === "openclaw" &&
    byIdempotencyKey.message.model === "delivery-mirror"
  ) {
    return byIdempotencyKey;
  }
  const expectedText = resolveMirroredTranscriptText({
    text: params.metadata?.text,
    mediaUrls: params.metadata?.mediaUrls,
  });
  if (!expectedText) {
    return null;
  }
  const target = params.events.findLast((event) => {
    const message = transcriptEventMessage(event);
    return (
      typeof transcriptEventId(event) === "string" &&
      message?.role === "assistant" &&
      message.provider === "openclaw" &&
      message.model === "delivery-mirror" &&
      extractAssistantTranscriptText(message) === expectedText
    );
  });
  return transcriptMessageTarget(target);
}

export async function persistAbortedPartials(params: {
  context: { logGateway: { warn: (message: string) => void } };
  snapshots: AbortedPartialSnapshot[];
}): Promise<string | undefined> {
  let warning: string | undefined;
  for (const snapshot of params.snapshots) {
    if (snapshot.ok && snapshot.settlement.deferred) {
      continue;
    }
    try {
      warning = (await persistAbortedPartial({ context: params.context, snapshot })) ?? warning;
    } catch (error) {
      throw abortedPartialPersistenceError(error, warning);
    }
  }
  return warning;
}

export async function persistAbortedPartial(params: {
  context: { logGateway: { warn: (message: string) => void } };
  snapshot: AbortedPartialSnapshot;
  producerSettled?: true;
}): Promise<string | undefined> {
  const { snapshot } = params;
  if (!snapshot.ok) {
    throw snapshot.error;
  }
  const appended = await appendInjectedAssistantMessageToTranscript({
    ...snapshot.value,
    abortMeta: {
      ...snapshot.value.abortMeta,
      ...(params.producerSettled ? { producerSettled: true } : {}),
    },
  });
  if (appended.skipped || appended.ok) {
    return undefined;
  }
  const error = `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`;
  params.context.logGateway.warn(error);
  if (snapshot.abortOrigin === "placement-abandon") {
    throw new Error(error);
  }
  return ABORTED_PARTIAL_PERSISTENCE_WARNING;
}

async function touchAssistantTranscriptSessionEntry(
  scope: SessionTranscriptWriteScope,
  readSource?: CapturedSessionEntryReadSource,
): Promise<void> {
  if (!scope.storePath || !scope.sessionKey || !scope.sessionId) {
    return;
  }
  const transcriptMarkerUpdatedAt = Date.now();
  const target = {
    storePath: scope.storePath,
    sessionKey: scope.sessionKey,
    ...(scope.agentId ? { agentId: scope.agentId } : {}),
  };
  const operation = {
    kind: "fields" as const,
    expected: { sessionId: scope.sessionId },
    patch: { updatedAt: transcriptMarkerUpdatedAt },
  };
  if (readSource) {
    await applySessionEntryTargetOperation(
      {
        ...target,
        readSource,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      },
      operation,
      { skipMaintenance: true },
    );
  } else {
    await applySessionEntryOperation(target, operation, { skipMaintenance: true });
  }
}

export async function rewriteSourceReplyTranscriptMirrors(params: {
  candidates: readonly SourceReplyTranscriptMirror[];
  requests: readonly SourceReplyTranscriptRewrite[];
  scope: SessionTranscriptWriteScope;
}): Promise<Array<{ messageId: string; request: SourceReplyTranscriptRewrite }>> {
  if (params.requests.length === 0 || params.candidates.length === 0) {
    return [];
  }

  return await withPreparedTranscriptCorrection(params.scope, async (transcript) => {
    const events = await transcript.readEvents();
    const findMirror = (mirror: SourceReplyTranscriptMirror) =>
      findSourceReplyTranscriptMirrorByMetadataInEvents({ ...mirror, events });
    const allowedSourceReplyMirrorIds = new Set<string>();
    for (const candidate of params.candidates) {
      const target = findMirror(candidate);
      if (target) {
        allowedSourceReplyMirrorIds.add(target.messageId);
      }
    }

    const rewriteTargets = params.requests.flatMap((request) => {
      const target = findMirror(request);
      return target ? [{ request, ...target }] : [];
    });
    if (rewriteTargets.length === 0) {
      return [];
    }

    const rewriteTargetIds = new Set(rewriteTargets.map((target) => target.messageId));
    const firstRewriteEntryIndex = events.findIndex((event) => {
      const id = transcriptEventId(event);
      return id ? rewriteTargetIds.has(id) : false;
    });
    const canRewriteSourceReplyMirrors =
      firstRewriteEntryIndex >= 0 &&
      events.slice(firstRewriteEntryIndex).every((event) => {
        const id = transcriptEventId(event);
        return !id || allowedSourceReplyMirrorIds.has(id);
      });
    if (!canRewriteSourceReplyMirrors) {
      return [];
    }

    const replacementsById = new Map(rewriteTargets.map((target) => [target.messageId, target]));
    const rewrittenEvents = events.map((event) => {
      const id = transcriptEventId(event);
      const replacement = id ? replacementsById.get(id) : undefined;
      if (!replacement) {
        return event;
      }
      const message = buildAssistantDisplayRewrite({
        message: {
          ...replacement.message,
          idempotencyKey: replacement.request.idempotencyKey,
        },
        displayContent: replacement.request.state.persistedContent,
        managedMediaUrls: replacement.request.metadata?.mediaUrls,
      });
      return Object.assign({}, event as Record<string, unknown>, {
        message,
      });
    });
    await transcript.replaceEvents(rewrittenEvents);
    return rewriteTargets.map((target) => ({
      messageId: target.messageId,
      request: target.request,
    }));
  });
}

export async function rewriteAssistantTranscriptMessageByIdempotencyKey(params: {
  content: AssistantDisplayContentBlock[];
  idempotencyKey: string;
  managedMediaUrls?: readonly string[];
  scope: SessionTranscriptWriteScope;
}): Promise<{ messageId: string } | null> {
  const idempotencyKey = params.idempotencyKey.trim();
  if (!idempotencyKey || params.content.length === 0) {
    return null;
  }
  return await withPreparedTranscriptCorrection(params.scope, async (transcript) => {
    const events = await transcript.readEvents();
    const target = findAssistantTranscriptMessageByIdempotencyKeyInEvents(events, idempotencyKey);
    if (!target) {
      return null;
    }
    const rewrittenEvents = events.map((event) =>
      transcriptEventId(event) === target.messageId
        ? Object.assign({}, event as Record<string, unknown>, {
            message: buildAssistantDisplayRewrite({
              message: target.message,
              displayContent: params.content,
              managedMediaUrls: params.managedMediaUrls,
            }),
          })
        : event,
    );
    await transcript.replaceEvents(rewrittenEvents);
    return { messageId: target.messageId };
  });
}

export async function rewriteAssistantTranscriptMessageByIdAndMedia(params: {
  afterSeq: number;
  messageId: string;
  content: AssistantDisplayContentBlock[];
  expectedGeneration: string | null;
  mediaUrls: readonly string[];
  rejectedMediaCount: number;
  scope: ResolvedAssistantTranscriptScope;
}): Promise<{ generation: string; messageId: string } | null> {
  if (
    params.content.length === 0 ||
    (params.mediaUrls.length === 0 && params.rejectedMediaCount === 0)
  ) {
    return null;
  }
  return withPreparedTranscriptCorrection(
    params.scope,
    async (transcript) => {
      const initialGenerationMaterialized =
        params.expectedGeneration === null && params.afterSeq === 0;
      if (transcript.generation !== params.expectedGeneration && !initialGenerationMaterialized) {
        return null;
      }
      // The pre-dispatch SQLite sequence is the exact turn boundary; timestamps can collide.
      // Exact-row rewrites preserve that sequence while rotating the generation returned to callers.
      const events = await transcript.readEvents();
      const target = findAssistantTranscriptMessageByIdAndMediaInEvents(events, params);
      if (!target) {
        return null;
      }
      const rewrittenMessage = {
        ...buildAssistantDisplayRewrite({
          message: target.message,
          // The committed source owns visible text too. A streamed tail or a
          // superseded media-only payload must not duplicate it in the display.
          displayContent: params.content.filter((block) => block.type !== "text"),
          managedMediaUrls: params.mediaUrls,
          retainOriginalText: true,
        }),
        content: target.message.content,
      };
      await transcript.replaceEvents(
        events.map((event) =>
          transcriptEventId(event) === target.messageId
            ? Object.assign({}, event as Record<string, unknown>, { message: rewrittenMessage })
            : event,
        ),
      );
      return transcript.generation
        ? { generation: transcript.generation, messageId: target.messageId }
        : null;
    },
    params.afterSeq,
  );
}

/** Adds managed display media to the completion reply without rewriting model content. */
export async function enrichAssistantTranscriptMediaForRun(params: {
  content: AssistantDisplayContentBlock[];
  mediaUrls: readonly string[];
  runId: string;
  expectedLifecycleRevision: SessionLifecycleRevisionExpectation;
  scope: ResolvedAssistantTranscriptScope;
  readSource?: CapturedSessionEntryReadSource;
}): Promise<{ messageId: string } | null> {
  return await rewritePreparedAssistantTranscriptMessageForRun({
    scope: params.scope,
    readSource: params.readSource,
    runId: params.runId,
    expectedLifecycleRevision: params.expectedLifecycleRevision,
    rewriteMessage: (message) => ({
      ...buildAssistantDisplayRewrite({
        message,
        displayContent: params.content,
        managedMediaUrls: params.mediaUrls,
        retainOriginalText: true,
      }),
      // The display projection owns MEDIA stripping; transcript signatures and
      // prompt-prefix bytes must remain identical to the model's original reply.
      content: message.content,
    }),
  });
}

export async function publishAssistantTranscriptRewrite(params: {
  scope: SessionTranscriptWriteScope;
  readSource?: CapturedSessionEntryReadSource;
  rewritten: readonly { messageId: string }[];
}): Promise<void> {
  if (params.rewritten.length === 0) {
    return;
  }
  await touchAssistantTranscriptSessionEntry(params.scope, params.readSource);
  await publishTranscriptUpdate(
    params.scope,
    { messageId: params.rewritten.at(-1)?.messageId },
    params.readSource,
  );
}
