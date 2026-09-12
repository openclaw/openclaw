// Transcript persistence and source-reply rewrites shared by chat send and abort.
import { asOptionalRecord as transcriptEventRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import {
  findTranscriptEvent,
  withTranscriptWriteLock,
  type SessionTranscriptWriteScope,
  type TranscriptEvent,
} from "../../config/sessions/session-accessor.js";
import type { SessionLifecycleRevisionExpectation } from "../../config/sessions/session-transcript-turn-lifecycle.types.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import {
  extractAssistantTranscriptText,
  findAssistantTranscriptMessageByIdempotencyKeyInEvents,
} from "../../config/sessions/transcript-assistant-rewrite.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../../shared/assistant-display-content.js";
import { loadSessionEntry } from "../session-utils.js";
import {
  sanitizeAssistantDisplayText,
  type AssistantDisplayContentBlock,
} from "./chat-assistant-content.js";
import {
  appendInjectedAssistantMessageToTranscript,
  type GatewayInjectedTtsSupplementMarker,
} from "./chat-transcript-inject.js";

type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  /** Set when the commit predicate declined the append; not an error. */
  skipped?: boolean;
  error?: string;
};

export type ChatAbortOrigin = "rpc" | "stop-command" | "placement-abandon";

export type ChatAbortSessionSnapshot = Result<
  Pick<
    ReturnType<typeof loadSessionEntry>,
    "cfg" | "storePath" | "entry" | "canonicalKey" | "agentId"
  >,
  unknown
>;

export type AbortedPartialSnapshot = {
  runId: string;
  abortOrigin: ChatAbortOrigin;
} & Result<Parameters<typeof appendAssistantTranscriptMessage>[0], unknown>;

type AssistantTranscriptScopeParams = {
  sessionId: string;
  storePath: string | undefined;
  sessionKey: string;
  agentId?: string;
};

type ResolvedAssistantTranscriptScope = SessionTranscriptWriteScope & { sessionId: string };

export type SourceReplyTranscriptMirrorMetadata = NonNullable<
  ReturnType<typeof getReplyPayloadMetadata>
>["sourceReplyTranscriptMirror"];

export type SourceReplyContentState = {
  broadcastContent: AssistantDisplayContentBlock[];
  persistedContent: AssistantDisplayContentBlock[];
  hasManagedOutgoingContent: boolean;
  backedManagedOutgoingContent: boolean;
};

function mergeAssistantDisplayContent(
  modelContent: AssistantDisplayContentBlock[],
  preparedDisplayContent: AssistantDisplayContentBlock[],
): AssistantDisplayContentBlock[] {
  const remainingDisplayContent = [...preparedDisplayContent];
  const content: AssistantDisplayContentBlock[] = [];
  for (const block of modelContent) {
    if (block.type !== "text" || typeof block.text !== "string") {
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

export function buildAssistantDisplayRewrite(params: {
  message: Record<string, unknown>;
  displayContent: AssistantDisplayContentBlock[];
  managedMediaUrls?: readonly string[];
  retainOriginalText?: true;
}): Record<string, unknown> {
  const prepared = applyAssistantDeliveryDirectives(
    {
      ...params.message,
      content: params.displayContent.map((block) => Object.assign({}, block)),
    },
    { managedMediaUrls: params.managedMediaUrls },
  );
  const original = Array.isArray(params.message.content)
    ? (params.message.content as AssistantDisplayContentBlock[])
    : [];
  const content: AssistantDisplayContentBlock[] = [];
  const seenText = new Set<string>();
  for (const block of original) {
    if (block.type === "thinking" || block.type === "toolCall") {
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
      if (text === block.text) {
        content.push(block);
      } else {
        const { textSignature: _textSignature, ...rest } = block;
        content.push({ ...rest, text });
      }
      seenText.add(text);
    }
  }
  for (const block of prepared.content) {
    if (block.type === "text" && typeof block.text === "string" && !seenText.has(block.text)) {
      content.push(block);
    }
  }
  return {
    ...prepared,
    content,
    [ASSISTANT_DISPLAY_CONTENT_FIELD]: mergeAssistantDisplayContent(content, prepared.content),
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
  const id = transcriptEventRecord(event)?.id;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

function transcriptEventMessage(event: TranscriptEvent): Record<string, unknown> | undefined {
  return transcriptEventRecord(transcriptEventRecord(event)?.message);
}

function findSourceReplyTranscriptMirrorByIdempotencyKeyInEvents(
  events: readonly TranscriptEvent[],
  idempotencyKey: string,
): { messageId: string; message: Record<string, unknown> } | null {
  const found = findAssistantTranscriptMessageByIdempotencyKeyInEvents(events, idempotencyKey);
  if (found?.message.provider !== "openclaw" || found.message.model !== "delivery-mirror") {
    return null;
  }
  return found;
}

function findSourceReplyTranscriptMirrorByMetadataInEvents(params: {
  events: readonly TranscriptEvent[];
  idempotencyKey: string;
  metadata: SourceReplyTranscriptMirrorMetadata;
}): { messageId: string; message: Record<string, unknown> } | null {
  const byIdempotencyKey = findSourceReplyTranscriptMirrorByIdempotencyKeyInEvents(
    params.events,
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
  const target = params.events.toReversed().find((event) => {
    const message = transcriptEventMessage(event);
    return (
      typeof transcriptEventId(event) === "string" &&
      message?.role === "assistant" &&
      message.provider === "openclaw" &&
      message.model === "delivery-mirror" &&
      extractAssistantTranscriptText(message) === expectedText
    );
  });
  const message = target ? transcriptEventMessage(target) : undefined;
  const messageId = target ? transcriptEventId(target) : undefined;
  if (!messageId || !message) {
    return null;
  }
  return { messageId, message };
}

async function transcriptExists(scope: SessionTranscriptWriteScope): Promise<boolean> {
  const sessionId = scope.sessionId;
  if (!sessionId) {
    return false;
  }
  // Existence probe: the newest-first matcher returns on the first record, so
  // this reads one transcript line instead of materializing the whole file.
  const found = await findTranscriptEvent({ ...scope, sessionId }, () => true).catch(
    () => undefined,
  );
  return found !== undefined;
}

export async function appendAssistantTranscriptMessage(params: {
  expectedSessionId?: string;
  expectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
  sessionKey: string;
  message: string;
  label?: string;
  content?: Array<Record<string, unknown>>;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  stopReason?: "stop" | "aborted";
  abortMeta?: {
    aborted: true;
    origin: ChatAbortOrigin;
    runId: string;
  };
  ttsSupplement?: GatewayInjectedTtsSupplementMarker;
  cfg?: OpenClawConfig;
}): Promise<TranscriptAppendResult> {
  const scope = assistantTranscriptScope(params);
  if (!scope) {
    return { ok: false, error: "transcript identity not resolved" };
  }
  if (!params.createIfMissing && !(await transcriptExists(scope))) {
    return { ok: false, error: "transcript not found" };
  }
  const appended = await appendInjectedAssistantMessageToTranscript({
    expectedSessionId: params.expectedSessionId,
    expectedLifecycleRevision: params.expectedLifecycleRevision,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    storePath: params.storePath,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    message: params.message,
    label: params.label,
    content: params.content,
    idempotencyKey: params.idempotencyKey,
    stopReason: params.stopReason,
    abortMeta: params.abortMeta,
    ttsSupplement: params.ttsSupplement,
    config: params.cfg,
  });
  return appended;
}

export function captureAbortedPartial(params: {
  runId: string;
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  text: string;
  abortOrigin: ChatAbortOrigin;
  session?: ChatAbortSessionSnapshot;
}): AbortedPartialSnapshot {
  const { runId, abortOrigin } = params;
  try {
    const session = params.session ?? {
      ok: true,
      value: loadSessionEntry(
        params.sessionKey,
        params.agentId ? { agentId: params.agentId } : undefined,
      ),
    };
    if (!session.ok) {
      throw session.error;
    }
    const { cfg, storePath, entry, canonicalKey, agentId } = session.value;
    if (entry?.sessionId !== params.sessionId) {
      throw new Error("Aborted partial transcript session changed before persistence");
    }
    // Snapshot the incarnation before signaling. Reset can keep the SID, and
    // the guarded writer rechecks both facts inside its commit transaction.
    return {
      runId,
      abortOrigin,
      ok: true,
      value: {
        sessionKey: canonicalKey,
        sessionId: params.sessionId,
        expectedSessionId: params.sessionId,
        expectedLifecycleRevision: entry.lifecycleRevision ?? null,
        agentId,
        storePath,
        cfg,
        message: params.text,
        createIfMissing: true,
        idempotencyKey: `${runId}:assistant`,
        abortMeta: { aborted: true, origin: abortOrigin, runId },
      },
    };
  } catch (error) {
    // Preparation is fallible metadata I/O, never a prerequisite for cancellation.
    return { runId, abortOrigin, ok: false, error };
  }
}

export async function persistAbortedPartials(params: {
  context: { logGateway: { warn: (message: string) => void } };
  snapshots: AbortedPartialSnapshot[];
}): Promise<void> {
  for (const snapshot of params.snapshots) {
    if (!snapshot.ok) {
      throw snapshot.error;
    }
    const appended = await appendAssistantTranscriptMessage(snapshot.value);
    if (appended.skipped) {
      continue;
    }
    if (!appended.ok) {
      const error = `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`;
      params.context.logGateway.warn(error);
      if (snapshot.abortOrigin === "placement-abandon") {
        throw new Error(error);
      }
    }
  }
}

export async function rewriteSourceReplyTranscriptMirrors(params: {
  candidates: readonly {
    idempotencyKey: string;
    metadata: SourceReplyTranscriptMirrorMetadata;
  }[];
  requests: readonly {
    idempotencyKey: string;
    metadata: SourceReplyTranscriptMirrorMetadata;
    state: SourceReplyContentState;
  }[];
  scope: SessionTranscriptWriteScope;
}): Promise<
  Array<{
    messageId: string;
    request: {
      idempotencyKey: string;
      metadata: SourceReplyTranscriptMirrorMetadata;
      state: SourceReplyContentState;
    };
  }>
> {
  if (params.requests.length === 0 || params.candidates.length === 0) {
    return [];
  }

  return await withTranscriptWriteLock(params.scope, async (transcript) => {
    const events = await transcript.readEvents();
    const allowedSourceReplyMirrorIds = new Set<string>();
    for (const candidate of params.candidates) {
      const target = findSourceReplyTranscriptMirrorByMetadataInEvents({
        events,
        idempotencyKey: candidate.idempotencyKey,
        metadata: candidate.metadata,
      });
      if (target) {
        allowedSourceReplyMirrorIds.add(target.messageId);
      }
    }

    const rewriteTargets: Array<{
      request: (typeof params.requests)[number];
      messageId: string;
      message: Record<string, unknown>;
    }> = [];
    for (const request of params.requests) {
      const target = findSourceReplyTranscriptMirrorByMetadataInEvents({
        events,
        idempotencyKey: request.idempotencyKey,
        metadata: request.metadata,
      });
      if (target) {
        rewriteTargets.push({ request, ...target });
      }
    }
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
  return await withTranscriptWriteLock(params.scope, async (transcript) => {
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
