import assert from "node:assert/strict";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/io.js";
import { prepareQualifiedSessionEntryTarget } from "../../config/sessions/session-accessor.entry.js";
import {
  appendTranscriptMessage,
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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntryAsync } from "../session-entry-load.test-support.js";
import * as sessionStoreReaders from "../session-utils-store-worker.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";

export function createReplyDispatch(
  clientRunId: string,
  overrides: Partial<Parameters<typeof createChatSendReplyDispatch>[0]> = {},
) {
  return createChatSendReplyDispatch({
    getRuntimeConfig,
    accountId: undefined,
    isAgentRunStarted: () => true,
    isRunCurrent: () => true,
    logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn: vi.fn() },
    session: {
      agentId: "main",
      backingSessionId: undefined,
      cfg: {},
      clientRunId,
      sessionKey: "agent:main:main",
      sessionLoadOptions: { agentId: "main" },
    },
    userTurnRecorder: { markBlocked: vi.fn(), getAdmissionReceipt: () => undefined },
    ...overrides,
  });
}

export async function createReplyTranscriptFixture(
  sessionKey = "agent:main:receipt",
  retainSource = false,
) {
  await captureRuntimeConfigAsyncReader()();
  const runId = "receipt-run";
  const scope = {
    agentId: "main",
    sessionId: "receipt-session",
    sessionKey,
    storePath: (await loadSessionEntryAsync(sessionKey, { agentId: "main" })).storePath,
  };
  const sessionEntry = {
    sessionId: scope.sessionId,
    lifecycleRevision: "initial",
    updatedAt: 1,
  };
  await replaceSessionEntry(scope, sessionEntry);
  const messageEvent = (
    messageId: string,
    message: Record<string, unknown>,
    parentId?: string,
  ) => ({
    eventId: messageId,
    message: attachSessionTranscriptRunId(message, runId),
    ...(parentId ? { parentId } : {}),
  });
  const appendSync = (messageId: string, message: Record<string, unknown>, parentId?: string) => {
    const event = messageEvent(messageId, message, parentId);
    const result = appendTranscriptMessageSync(scope, event);
    assert(result?.ok, "Expected committed receipt fixture message");
    return event.message;
  };
  const append = async (messageId: string, message: Record<string, unknown>, parentId?: string) => {
    const event = messageEvent(messageId, message, parentId);
    const result = await appendTranscriptMessage(scope, event);
    assert(result.messageId, "Expected committed receipt fixture message");
    // Tool-bearing assistant updates intentionally have no top-level runId.
    await publishTranscriptUpdate(scope, { message: event.message, messageId });
  };
  const rewriteSync = (messageId: string, content: string) => {
    const resolved = resolveSqliteTranscriptScope(scope);
    runOpenClawAgentWriteTransaction((database) => {
      const row = readTranscriptEventRows(database, scope.sessionId).find(
        ({ eventJson }) => asOptionalRecord(JSON.parse(eventJson))?.id === messageId,
      );
      assert(row, "Expected committed receipt fixture to rewrite");
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
    input: { text: "Inspect the synthetic fixture.", idempotencyKey: `${runId}:user` },
    target: { ...scope, sessionEntry },
  });
  const persistedInput = await userTurnRecorder.persistApproved();
  assert(persistedInput?.messageId, "Expected committed input admission");
  const loaded = retainSource
    ? await sessionStoreReaders.loadGatewaySessionEntryReadOnlyInWorker({
        cfg: getRuntimeConfig(),
        key: sessionKey,
        agentId: scope.agentId,
      })
    : undefined;
  const qualified =
    loaded &&
    (await prepareQualifiedSessionEntryTarget(
      {
        ...loaded,
        requestedKey: sessionKey,
        storeKey: loaded.canonicalKey,
        readSource: loaded.capturedReadSource,
      },
      loaded.capturedReadSources,
    ));
  let current = true;
  const abortController = new AbortController();
  const dispatch = createReplyDispatch(runId, {
    isRunCurrent: () => current,
    assertWorkCurrent: qualified
      ? () => {
          assert(current && !abortController.signal.aborted, "Reply fixture work ended");
        }
      : undefined,
    abortSignal: abortController.signal,
    session: {
      ...scope,
      entry: sessionEntry,
      backingSessionId: scope.sessionId,
      cfg: loaded?.cfg ?? {},
      ...(qualified && {
        sessionTarget: qualified,
        capturedReadSources: loaded?.capturedReadSources,
      }),
      clientRunId: runId,
      sessionLoadOptions: { agentId: "main" },
    },
    userTurnRecorder,
  });
  return {
    scope,
    runId,
    inputId: persistedInput.messageId,
    userTurnRecorder,
    append,
    appendSync,
    rewriteSync,
    dispatch,
    abortController,
    release: () => void (current = false),
    retire: () => void (current = false),
  };
}

type ReplyFixture = Awaited<ReturnType<typeof createReplyTranscriptFixture>>;
export function withReplyTranscript(
  run: (fixture: ReplyFixture, state: OpenClawTestState) => Promise<void>,
  active = false,
) {
  return withOpenClawTestState({ label: "reply-transcript" }, async (state) => {
    const fixture = await createReplyTranscriptFixture();
    const execute = () => run(fixture, state);
    await (active
      ? fixture.dispatch.runAgentMediaTranscript({ run: async (operation) => operation() }, execute)
      : execute());
  });
}
