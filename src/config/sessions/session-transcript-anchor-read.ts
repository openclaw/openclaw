import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { readOpenClawAgentDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { captureIncognitoSessionHistoryBinding } from "./session-incognito-binding.js";
import {
  prepareIncognitoSessionHistoryRead,
  type IncognitoSessionHistoryBinding,
} from "./session-incognito-history-read.js";
import {
  prepareSessionTranscriptAnchorMessageReader,
  readSessionTranscriptAnchorFactsInDatabase,
  type SessionTranscriptAnchorSelection,
} from "./session-transcript-anchor-read.kernel.js";
import type { SessionTranscriptAnchorFacts } from "./session-transcript-anchor-read.types.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import { getOwnedSessionTranscriptReader } from "./transcript-write-context.js";

type AnchorScope = SessionTranscriptReadScope & { sessionKey: string };

/** Capture the physical source before discovery or history admission can yield. */
export async function readSessionTranscriptAnchorsAsync(
  scope: AnchorScope,
  selection: SessionTranscriptAnchorSelection,
  signal?: AbortSignal,
  /** Consume only a current snapshot, while its original writer FIFO and reader remain retained. */
  onRead?: (facts: SessionTranscriptAnchorFacts) => void,
  suppliedIncognito?: IncognitoSessionHistoryBinding,
): Promise<SessionTranscriptAnchorFacts> {
  const consume = (facts: SessionTranscriptAnchorFacts) => {
    const consumed = onRead?.(facts);
    if (isPromiseLike(consumed)) {
      void Promise.resolve(consumed).catch(() => {});
      throw new Error("Transcript anchor consumers must remain synchronous");
    }
  };
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryBinding(scope);
  if (incognito) {
    const { actor, authority, target } = prepareIncognitoSessionHistoryRead(
      incognito,
      scope,
      signal,
    );
    const facts = await actor.sessions.history(
      authority,
      { type: "session.history.anchors", input: { ...selection, ...target } },
      signal,
      onRead ? consume : undefined,
    );
    authority.assertCurrent();
    return facts;
  }
  const selected =
    selection.afterSeq === undefined &&
    selection.includeMessagesForRunId === undefined &&
    getOwnedSessionTranscriptReader(scope);
  if (selected) {
    return selected.withRead(
      {
        sessionKeys: [selected.sessionKey],
        snapshotFields: [],
        transcript: { ...selection, sessionKey: selected.sessionKey },
      },
      () => signal?.throwIfAborted(),
      (read, assertCurrent) => {
        assertCurrent();
        const entry = read.entries.find((row) => row.sessionKey === selected.sessionKey)?.entry;
        if (entry?.sessionId !== scope.sessionId || !read.transcript) {
          throw new Error("Transcript anchors changed their admitted session");
        }
        consume(read.transcript);
        return read.transcript;
      },
    );
  }
  const captured = {
    agentId: scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey),
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const request = {
    entryIds: [...selection.entryIds],
    afterSeq: selection.afterSeq,
    includeMessagesForRunId: selection.includeMessagesForRunId,
    includeSession: selection.includeSession,
    includeHeader: selection.includeHeader,
    includeWatermark: selection.includeWatermark,
    includeMessagePresence: selection.includeMessagePresence,
    contextValidation: selection.contextValidation && structuredClone(selection.contextValidation),
    contextAuthority: selection.contextAuthority && structuredClone(selection.contextAuthority),
    replayValidation: selection.replayValidation && { ...selection.replayValidation },
  };
  const empty: SessionTranscriptAnchorFacts = {
    anchors: [],
    ...(request.replayValidation?.allowInitial ? { replayValidated: "initial" } : {}),
  };
  signal?.throwIfAborted();
  return withSessionTranscriptReadSource(
    captured,
    () => {
      const resolved = resolveSqliteTranscriptScope(captured);
      const options = toDatabaseOptions(resolved);
      const database = getOpenClawAgentDatabaseIfOpen(options);
      const read = (
        readMessage?: Parameters<typeof readSessionTranscriptAnchorFactsInDatabase>[3],
      ) => {
        signal?.throwIfAborted();
        if (getOpenClawAgentDatabaseIfOpen(options) !== database) {
          throw new Error("Transcript anchors changed their captured native database owner");
        }
        // Process-held transcripts must never be reopened by a durable reader.
        const facts = database
          ? readOpenClawAgentDatabase(database, (reader) =>
              readSessionTranscriptAnchorFactsInDatabase(reader, resolved, request, readMessage),
            ).value
          : empty;
        consume(facts);
        return facts;
      };
      return !database || request.includeMessagesForRunId === undefined
        ? read()
        : prepareSessionTranscriptAnchorMessageReader(request).then(read);
    },
    async ({ resolved, owner, expectedIdentity, assertCurrent }) => {
      if (!expectedIdentity) {
        consume(empty);
        return empty;
      }
      const options = toDatabaseOptions(resolved);
      const read = async () => {
        const native = onRead ? getOpenClawAgentDatabaseIfOpen(options) : undefined;
        if (native?.db.isTransaction) {
          return { anchors: [] };
        }
        const revision = native && readSqliteNativeMutationRevision(native.db);
        const facts = await owner.readAnchors(
          {
            resolved: { ...resolved, sessionKey: resolved.sessionKey ?? captured.sessionKey },
            selection: request,
            expectedIdentity,
          },
          signal,
        );
        assertCurrent();
        // Legacy synchronous writers bypass the FIFO and may not publish row changes.
        if (
          onRead &&
          getOpenClawAgentDatabaseIfOpen(options) === native &&
          (!native ||
            (!native.db.isTransaction &&
              revision !== undefined &&
              readSqliteNativeMutationRevision(native.db) === revision))
        ) {
          consume(facts);
        }
        return facts;
      };
      return onRead
        ? runOpenClawAgentWriteAdmission(
            options,
            async (_identity, assertSource) => {
              assertCurrent();
              const facts = await read();
              assertSource();
              return facts;
            },
            true,
            undefined,
            signal,
          )
        : read();
    },
    signal,
  );
}

export async function readActiveTranscriptEntryAnchorAsync(
  scope: AnchorScope & { entryId: string },
  signal?: AbortSignal,
  incognito?: IncognitoSessionHistoryBinding,
) {
  const result = await readSessionTranscriptAnchorsAsync(
    scope,
    { entryIds: [scope.entryId] },
    signal,
    undefined,
    incognito,
  );
  return result.anchors[0];
}
