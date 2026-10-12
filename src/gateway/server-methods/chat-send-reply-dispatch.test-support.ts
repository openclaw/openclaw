import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { getRuntimeConfig } from "../../config/io.js";
import { prepareQualifiedSessionEntryTarget } from "../../config/sessions/session-accessor.entry.js";
import {
  appendTranscriptMessageSync,
  publishTranscriptUpdate,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import * as sessionStoreReaders from "../session-utils-store-worker.js";
import { loadSessionEntry } from "../session-utils.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";

export async function createReplyTranscriptFixture(
  sessionKey = "agent:main:receipt",
  retainSource = false,
) {
  const runId = "receipt-run";
  const scope = {
    agentId: "main",
    sessionId: "receipt-session",
    sessionKey,
    storePath: loadSessionEntry(sessionKey, { agentId: "main" }).storePath,
  };
  const sessionEntry = {
    sessionId: scope.sessionId,
    lifecycleRevision: "initial",
    updatedAt: 1,
  };
  await replaceSessionEntry(scope, sessionEntry);
  const appendSync = (messageId: string, message: Record<string, unknown>, parentId?: string) => {
    const persisted = attachSessionTranscriptRunId(message, runId);
    const result = appendTranscriptMessageSync(scope, {
      eventId: messageId,
      message: persisted,
      ...(parentId ? { parentId } : {}),
    });
    if (!result?.ok) {
      throw new Error("Expected committed receipt fixture message");
    }
    return persisted;
  };
  const append = async (messageId: string, message: Record<string, unknown>, parentId?: string) => {
    const persisted = appendSync(messageId, message, parentId);
    // Tool-bearing assistant updates intentionally have no top-level runId.
    await publishTranscriptUpdate(scope, { message: persisted, messageId });
  };
  const rewriteSync = (messageId: string, content: string) => {
    const resolved = resolveSqliteTranscriptScope(scope);
    runOpenClawAgentWriteTransaction((database) => {
      const row = readTranscriptEventRows(database, scope.sessionId).find(
        ({ eventJson }) => asOptionalRecord(JSON.parse(eventJson))?.id === messageId,
      );
      if (!row) {
        throw new Error("Expected committed receipt fixture to rewrite");
      }
      const event = asOptionalRecord(JSON.parse(row.eventJson));
      rewriteSqliteTranscriptEventRowsInTransaction(database, resolved, [
        {
          seq: row.seq,
          expectedEventJson: row.eventJson,
          event: { ...event, message: { ...asOptionalRecord(event?.message), content } },
        },
      ]);
    }, toDatabaseOptions(resolved));
  };
  const userTurnRecorder = createUserTurnTranscriptRecorder({
    input: {
      text: "Inspect the synthetic fixture.",
      idempotencyKey: `${runId}:user`,
    },
    target: { ...scope, sessionEntry },
  });
  const persistedInput = await userTurnRecorder.persistApproved();
  if (!persistedInput?.messageId) {
    throw new Error("Expected committed input admission");
  }
  const loaded = retainSource
    ? await sessionStoreReaders.loadGatewaySessionEntryReadOnlyInWorker({
        cfg: getRuntimeConfig(),
        key: sessionKey,
        agentId: scope.agentId,
      })
    : undefined;
  const qualified =
    loaded &&
    prepareQualifiedSessionEntryTarget(
      {
        ...loaded,
        requestedKey: sessionKey,
        storeKey: loaded.canonicalKey,
        readSource: loaded.capturedReadSource,
      },
      loaded.capturedReadSources,
    );
  let current = true;
  const abortController = new AbortController();
  const dispatch = createChatSendReplyDispatch({
    getRuntimeConfig,
    accountId: undefined,
    isAgentRunStarted: () => true,
    isRunCurrent: () => current,
    assertWorkCurrent: qualified
      ? () => {
          if (!current || abortController.signal.aborted) {
            throw new Error("Reply fixture work ended");
          }
        }
      : undefined,
    abortSignal: abortController.signal,
    logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn: vi.fn() },
    session: {
      ...scope,
      entry: sessionEntry,
      backingSessionId: scope.sessionId,
      cfg: loaded?.cfg ?? {},
      ...(qualified
        ? {
            sessionTarget: qualified.target,
            assertSessionTargetCurrent: qualified.assertCurrent,
            capturedReadSources: loaded?.capturedReadSources,
          }
        : {}),
      clientRunId: runId,
      sessionLoadOptions: { agentId: "main" },
    },
    userTurnRecorder,
  });
  return {
    scope,
    runId,
    inputId: persistedInput.messageId,
    append,
    appendSync,
    rewriteSync,
    dispatch,
    abortController,
    release: () => qualified?.release(),
    retire: () => {
      current = false;
    },
  };
}
