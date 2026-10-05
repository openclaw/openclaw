import path from "node:path";
import {
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
} from "../../infra/sqlite-worker-identity.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Retain the original physical transcript through preparation, reading and consumption. */
export async function withSessionTranscriptReadSource<T>(
  scope: SessionTranscriptReadScope,
  readInProcess: (scope: SessionTranscriptReadScope) => T | Promise<T>,
  readInWorker: (source: {
    scope: SessionTranscriptReadScope & { agentId: string; storePath: string };
    resolved: ResolvedTranscriptReadScope;
    owner: SessionHistoryWorkerDatabase;
    expectedIdentity?: DatabaseFileIdentity;
    assertCurrent: () => void;
  }) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const captured = {
    ...scope,
    sessionEntry: scope.sessionEntry ? { ...scope.sessionEntry } : undefined,
    ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const agentId = normalizeAgentId(
    captured.agentId ??
      parseAgentSessionKey(captured.sessionKey)?.agentId ??
      captured.defaultAgentId,
  );
  signal?.throwIfAborted();
  if (
    isIncognitoSessionKey(captured.sessionKey) ||
    (captured.storePath &&
      isIncognitoOpenClawAgentSqlitePath(captured.storePath, { agentId, env: captured.env }))
  ) {
    return readInProcess(captured);
  }
  const storePath =
    captured.storePath ?? resolveOpenClawAgentSqlitePath({ agentId, env: captured.env });
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const context = captureOpenClawStateReadWorkerContext({ env: captured.env });
  return withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
    const resolved = await prepareSqliteTranscriptReadScope(captured, signal);
    const options = toDatabaseOptions(resolved);
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    const identity = identities.get(assertSessionStoreReadCandidate(databasePath, candidates));
    const selectedIdentity = identity ?? readDatabasePathIdentitySync(databasePath);
    if (!identity && selectedIdentity.key.startsWith("file:")) {
      throw new Error("Transcript read changed its captured database owner");
    }
    const assertSource = () => {
      signal?.throwIfAborted();
      context.maintenanceScope?.assertAdmission();
      context.admission.assertCurrent();
      discovery.assertCurrent();
      assertSessionStoreReadCandidate(databasePath, candidates);
      const current = readDatabasePathIdentitySync(databasePath);
      if (
        current.key !== selectedIdentity.key ||
        current.birthtime !== selectedIdentity.birthtime
      ) {
        throw new Error("Transcript read changed its captured database owner");
      }
    };
    assertSource();
    return withSessionHistoryWorkerDatabase(
      { ...options, requestedPath: storePath },
      async (owner) => {
        const assertCurrent = () => {
          assertSource();
          owner.assertCurrent();
        };
        try {
          return await readInWorker({
            scope: { ...captured, agentId: resolved.agentId, storePath: databasePath },
            resolved: { ...resolved, path: databasePath },
            owner,
            expectedIdentity: selectedIdentity.key.startsWith("file:")
              ? selectedIdentity
              : undefined,
            assertCurrent,
          });
        } finally {
          assertCurrent();
        }
      },
    );
  });
}
