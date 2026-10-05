import path from "node:path";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { readOpenClawAgentDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteTranscriptReadScope,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  prepareIncognitoSessionHistoryRead,
  type IncognitoSessionHistoryBinding,
} from "./session-incognito-history-read.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import {
  readSessionTranscriptAnchorFactsInDatabase,
  type SessionTranscriptAnchorFacts,
  type SessionTranscriptAnchorSelection,
} from "./session-transcript-anchor-read.kernel.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

type AnchorScope = SessionTranscriptReadScope & { sessionKey: string };

/** Capture the physical source before discovery or history admission can yield. */
export async function readSessionTranscriptAnchorsAsync(
  scope: AnchorScope,
  selection: SessionTranscriptAnchorSelection,
  signal?: AbortSignal,
  /** Consume only a current snapshot, while its original writer FIFO and reader remain retained. */
  onRead?: (facts: SessionTranscriptAnchorFacts) => void,
  incognito?: IncognitoSessionHistoryBinding,
): Promise<SessionTranscriptAnchorFacts> {
  if (incognito) {
    const { actor, authority, target } = prepareIncognitoSessionHistoryRead(
      incognito,
      scope,
      signal,
    );
    return actor.sessions.history(
      authority,
      { type: "session.history.anchors", input: { ...selection, ...target } },
      signal,
      onRead,
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
    includeSession: selection.includeSession,
    contextValidation: selection.contextValidation && structuredClone(selection.contextValidation),
  };
  signal?.throwIfAborted();
  if (
    isIncognitoSessionKey(captured.sessionKey) ||
    (captured.storePath && isIncognitoOpenClawAgentSqlitePath(captured.storePath, captured))
  ) {
    const resolved = resolveSqliteTranscriptScope(captured);
    const database = getOpenClawAgentDatabaseIfOpen(toDatabaseOptions(resolved));
    // Process-held transcripts must never be reopened by a durable reader.
    const facts = database
      ? readOpenClawAgentDatabase(database, (reader) =>
          readSessionTranscriptAnchorFactsInDatabase(reader, resolved, request),
        ).value
      : { anchors: [] };
    onRead?.(facts);
    return facts;
  }
  const storePath = captured.storePath ?? resolveOpenClawAgentSqlitePath(captured);
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const context = captureOpenClawStateReadWorkerContext({ env: captured.env });
  return withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
    const resolved = await prepareSqliteTranscriptReadScope(captured, signal);
    const options = toDatabaseOptions(resolved);
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    const identity = identities.get(assertSessionStoreReadCandidate(databasePath, candidates));
    const assertCurrent = () => {
      signal?.throwIfAborted();
      context.maintenanceScope?.assertAdmission();
      context.admission.assertCurrent();
      discovery.assertCurrent();
      assertSessionStoreReadCandidate(databasePath, candidates);
      const current = readDatabasePathIdentitySync(databasePath);
      if (identity && (current.key !== identity.key || current.birthtime !== identity.birthtime)) {
        throw new Error("Transcript anchors changed their captured database owner");
      }
    };
    assertCurrent();
    if (!identity) {
      if (!readDatabasePathIdentitySync(databasePath).key.startsWith("file:")) {
        onRead?.({ anchors: [] });
        return { anchors: [] };
      }
      throw new Error("Transcript anchors changed their captured database owner");
    }
    if (!identity.key.startsWith("file:")) {
      onRead?.({ anchors: [] });
      return { anchors: [] };
    }
    return withSessionHistoryWorkerDatabase(
      { ...options, requestedPath: storePath },
      async (owner) => {
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
              expectedIdentity: identity,
            },
            signal,
          );
          assertCurrent();
          owner.assertCurrent();
          // Legacy synchronous writers cannot await the FIFO. Its existing native
          // mutation witness also catches unpublished writes through that handle.
          if (
            onRead &&
            getOpenClawAgentDatabaseIfOpen(options) === native &&
            (!native ||
              (!native.db.isTransaction &&
                revision !== undefined &&
                readSqliteNativeMutationRevision(native.db) === revision))
          ) {
            onRead(facts);
          }
          return facts;
        };
        try {
          return onRead
            ? await runOpenClawAgentWriteAdmission(
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
            : await read();
        } finally {
          assertCurrent();
          owner.assertCurrent();
        }
      },
    );
  });
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
