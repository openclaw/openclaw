import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadExactSessionEntry,
  persistSessionTranscriptTurn,
  readActiveTranscriptEntryAnchor,
  resolveSessionEntrySelection,
  resolveSessionTranscriptRuntimeTarget,
  type TranscriptMessageAppendResult,
} from "../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionActor,
} from "../config/sessions/session-incognito-binding.js";
import { readActiveTranscriptEntryAnchorAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { findTranscriptEvent } from "../config/sessions/session-transcript-match.js";
import { sessionMatchesExpectedTranscriptTurn } from "../config/sessions/session-transcript-turn-state.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptWriterFence,
  withSessionTranscriptWriteAssertion,
} from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentScopedMediaLocalRootsForSources } from "../media/local-roots.js";
import {
  readAssistantDisplayContent,
  retainAssistantModelContent,
} from "../shared/assistant-display-content.js";
import { readClawHubRecommendations } from "../shared/clawhub-recommendations.js";
import { prepareEffectAuthority } from "../shared/effect-authority.js";
import { createKeyedFifoLeaseRegistry } from "../shared/keyed-fifo-lease.js";
import { IncognitoSessionMissingError } from "../state/incognito-session-error.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
  prepareOutgoingMediaFromReplyPayload,
  removeManagedOutgoingMediaBlocks,
} from "./managed-image-attachments.js";

const internalSourceReplyPersistenceLeases = createKeyedFifoLeaseRegistry(
  Symbol.for("openclaw.internalSourceReplyPersistenceLeases"),
);

async function withPreparedSourceReplyWrite<T>(
  scope: Parameters<typeof withSessionTranscriptWriteAssertion>[0],
  write: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  // Preparation may fetch media through this same authority owner; hold only for persistence.
  const use = await prepareEffectAuthority();
  const persist = () => write(captureOwnedTranscriptWriteAssertion(scope));
  return use
    ? use.persist((assertCurrent) =>
        withSessionTranscriptWriteAssertion(scope, assertCurrent, persist),
      )
    : persist();
}

async function completePersistedInternalSourceReply(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  expectedSessionId?: string;
  agentId?: string;
  idempotencyKey?: string;
}): Promise<boolean> {
  if (!params.expectedSessionId || !params.idempotencyKey) {
    return false;
  }
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const requested = {
    agentId: params.agentId,
    sessionId: params.expectedSessionId,
    sessionKey: params.sessionKey,
    storePath,
  };
  const source = captureIncognitoSessionSource(requested);
  const scope = source
    ? await resolveSessionTranscriptRuntimeTarget(requested, params.cfg)
    : { ...requested, sessionKey: resolveSessionEntrySelection(requested).normalizedKey };
  const assertCurrent = captureOwnedTranscriptWriteAssertion(scope);
  const expected = {
    expectedSessionId: params.expectedSessionId,
    ...getOwnedSessionTranscriptWriterFence({ sessionKey: scope.sessionKey }),
  };
  const found = await findTranscriptEvent(scope, {
    kind: "idempotency",
    key: params.idempotencyKey,
    deliveryMirror: true,
  });
  if (!found) {
    return false;
  }
  const messageId = readTranscriptEventId(found.event);
  const message = readTranscriptEventMessage(found.event);
  if (!messageId || !message) {
    throw new Error("Internal source reply transcript identity is unavailable");
  }
  const assertCurrentReplay = (entryId: string) => {
    assertCurrent();
    if (
      !sessionMatchesExpectedTranscriptTurn(loadExactSessionEntry(scope), expected) ||
      !readActiveTranscriptEntryAnchor({ ...scope, entryId })
    ) {
      throw new Error("Internal source reply no longer owns the active transcript");
    }
  };
  // Replay also refreshes history when an earlier owned drain suppressed publication.
  // Preserve the original bytes and run provenance; never restage a retry.
  const options: Parameters<typeof persistSessionTranscriptTurn>[1] = {
    config: params.cfg,
    ...expected,
    assertCurrent,
    messages: [
      {
        eventId: messageId,
        message,
        idempotencyLookup: "scan",
        predicate: {
          kind: "active-entry",
          entryId: messageId,
          errorMessage: "Internal source reply no longer owns the active transcript",
        },
      },
    ],
    touchSessionEntry: false,
    updateMode: "file-only",
    publishWhen: "always",
    onMessageCommitted: (result, acceptCompletion) => {
      if (source) {
        acceptCompletion(async () => {
          await withSessionEntryReadOnlyInWorker(scope, assertCurrent, async (read, owner) => {
            if (!read.ok) {
              throw read.error;
            }
            if (
              !sessionMatchesExpectedTranscriptTurn(
                read.value ? { entry: read.value } : undefined,
                expected,
              ) ||
              !(await readActiveTranscriptEntryAnchorAsync({ ...scope, entryId: result.messageId }))
            ) {
              throw new Error("Internal source reply no longer owns the active transcript");
            }
            owner.assertCurrent();
          });
          await attachSourceReplyMedia(result);
        });
      } else {
        assertCurrentReplay(result.messageId);
        acceptCompletion(() => attachSourceReplyMedia(result));
      }
    },
  };
  const replay = await withPreparedSourceReplyWrite(scope, (assertWriteCurrent) =>
    persistSessionTranscriptTurn(scope, { ...options, assertCurrent: assertWriteCurrent }),
  );
  if (replay.rejectedReason || replay.messages.length === 0) {
    throw new Error("Internal source reply no longer owns the active transcript");
  }
  return true;
}

async function attachSourceReplyMedia(
  result: TranscriptMessageAppendResult<unknown>,
): Promise<void> {
  // Catalog cards are display content, not media custody; only media is promoted after commit.
  const message = result.message;
  const blocks = readAssistantDisplayContent(message).filter(
    (block) => block.type !== "text" && block.type !== "clawhub",
  );
  if (blocks.length > 0) {
    if (!(await attachManagedOutgoingMediaToMessage({ messageId: result.messageId, blocks }))) {
      throw new Error("Internal source reply media ownership could not be persisted");
    }
  }
}

/** Persist the private WebChat source reply before its successful tool result becomes visible. */
export async function persistInternalSourceReply(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  expectedSessionId?: string;
  agentId?: string;
  payload: ReplyPayload;
  idempotencyKey?: string;
  runId?: string;
  sourceReplyFinal?: boolean;
  toolCallId?: string;
  sourceTurnId?: string;
}): Promise<void> {
  const source = captureIncognitoSessionSource({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (source && "kind" in source) {
    throw new IncognitoSessionMissingError();
  }
  const persist = async () => {
    const leaseKey = params.idempotencyKey
      ? JSON.stringify([
          params.agentId ?? "",
          params.sessionKey,
          params.expectedSessionId ?? "",
          params.idempotencyKey,
        ])
      : undefined;
    const lease = leaseKey ? internalSourceReplyPersistenceLeases.reserve([leaseKey]) : undefined;
    await lease?.wait();
    try {
      if (await completePersistedInternalSourceReply(params)) {
        return;
      }
      const media = prepareOutgoingMediaFromReplyPayload(params.payload);
      // Prepared media is transient until commit so maintenance cannot reap it as missing history.
      const mediaBlocks = await createManagedOutgoingMediaBlocks({
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        items: media,
        localRoots: getAgentScopedMediaLocalRootsForSources({
          cfg: params.cfg,
          agentId: params.agentId,
          mediaSources: media.map((item) => item.url),
        }),
      });
      let committed = false;
      try {
        const content: Array<Record<string, unknown>> = [
          ...readClawHubRecommendations(params.payload.channelData),
          ...(params.payload.text ? [{ type: "text", text: params.payload.text }] : []),
          ...mediaBlocks,
        ];
        const writerFence = getOwnedSessionTranscriptWriterFence({
          sessionKey: params.sessionKey,
        });
        const options: Parameters<typeof appendAssistantMessageToSessionTranscript>[0] = {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
          ...(writerFence?.expectedLifecycleRevision !== undefined
            ? { expectedLifecycleRevision: writerFence.expectedLifecycleRevision }
            : {}),
          ...(writerFence ? { expectedWriterRunId: writerFence.expectedWriterRunId } : {}),
          content: retainAssistantModelContent(content),
          displayContent: content,
          mediaUrls: media.map((item) => item.url),
          idempotencyKey: params.idempotencyKey,
          runId: params.runId,
          ...(params.sourceReplyFinal !== undefined
            ? {
                deliveryMirror: {
                  kind: "message-tool-source-reply" as const,
                  final: params.sourceReplyFinal,
                  ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
                  ...(params.sourceTurnId ? { sourceTurnId: params.sourceTurnId } : {}),
                },
              }
            : {}),
          config: params.cfg,
          onMessageCommitted: (result, acceptCompletion) => {
            // Publication can fail after commit; cleanup must never delete owned media.
            committed = result.appended;
            acceptCompletion(() => attachSourceReplyMedia(result));
          },
        };
        const appended = await withPreparedSourceReplyWrite(
          {
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            sessionId: params.expectedSessionId,
            storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
              agentId: params.agentId,
            }),
          },
          (assertCurrent) =>
            appendAssistantMessageToSessionTranscript({ ...options, assertCurrent }),
        );
        if (!appended.ok) {
          throw new Error(`Internal source reply persistence failed: ${appended.reason}`);
        }
      } finally {
        if (!committed) {
          await removeManagedOutgoingMediaBlocks({ blocks: mediaBlocks, messageId: null });
        }
      }
    } finally {
      lease?.release();
    }
  };
  return source
    ? withIncognitoSessionActor(source.actor, persist, source.admissionSignal)
    : persist();
}
