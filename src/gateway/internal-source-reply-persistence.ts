import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  persistSessionTranscriptTurn,
  resolveSessionEntrySelection,
  type TranscriptMessageAppendResult,
} from "../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { findTranscriptEvent } from "../config/sessions/session-transcript-match.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptWriterFence,
} from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentScopedMediaLocalRootsForSources } from "../media/local-roots.js";
import {
  readAssistantDisplayContent,
  retainAssistantModelContent,
} from "../shared/assistant-display-content.js";
import { readClawHubRecommendations } from "../shared/clawhub-recommendations.js";
import { createKeyedFifoLeaseRegistry } from "../shared/keyed-fifo-lease.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
  prepareOutgoingMediaFromReplyPayload,
  removeManagedOutgoingMediaBlocks,
} from "./managed-image-attachments.js";

const internalSourceReplyPersistenceLeases = createKeyedFifoLeaseRegistry(
  Symbol.for("openclaw.internalSourceReplyPersistenceLeases"),
);

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
  const scope = {
    agentId: params.agentId,
    sessionId: params.expectedSessionId,
    sessionKey: params.sessionKey,
    storePath,
  };
  scope.sessionKey = resolveSessionEntrySelection(scope).normalizedKey;
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
      assertCurrent();
      attachSourceReplyMedia(result, acceptCompletion);
    },
  };
  const replay = await persistSessionTranscriptTurn(scope, options);
  if (replay.rejectedReason || replay.messages.length === 0) {
    throw new Error("Internal source reply no longer owns the active transcript");
  }
  return true;
}

function attachSourceReplyMedia(
  result: TranscriptMessageAppendResult<unknown>,
  acceptCompletion: (complete: () => Promise<void>) => void,
): void {
  // Catalog cards are display content, not media custody; only media is promoted after commit.
  const message = result.message;
  const blocks = readAssistantDisplayContent(message).filter(
    (block) => block.type !== "text" && block.type !== "clawhub",
  );
  if (blocks.length > 0) {
    acceptCompletion(async () => {
      if (!(await attachManagedOutgoingMediaToMessage({ messageId: result.messageId, blocks }))) {
        throw new Error("Internal source reply media ownership could not be persisted");
      }
    });
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
          attachSourceReplyMedia(result, acceptCompletion);
        },
      };
      const appended = await appendAssistantMessageToSessionTranscript({
        ...options,
        assertCurrent: captureOwnedTranscriptWriteAssertion({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.expectedSessionId,
          storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
            agentId: params.agentId,
          }),
        }),
      });
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
}
