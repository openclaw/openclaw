import path from "node:path";
import {
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
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
import {
  createPreparedSessionTranscriptReads,
  type PreparedSessionTranscriptReads,
} from "./session-transcript-execution-read.js";
import {
  withSessionHistoryWorkerReadCandidates,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import { getOwnedSessionTranscriptReader } from "./transcript-write-context.js";

export type SessionTranscriptWorkerReadSource = {
  scope: SessionTranscriptReadScope & {
    agentId: string;
    storePath: string;
    env: NodeJS.ProcessEnv;
  };
  resolved: ResolvedTranscriptReadScope;
  owner: SessionHistoryWorkerDatabase;
  preparedReads?: PreparedSessionTranscriptReads;
  expectedIdentity?: DatabaseFileIdentity;
  assertCurrent: () => void;
};

/** Read through an anchor locator while retaining the requested physical source and its authority. */
export async function withSessionTranscriptReadSource<T>(
  scope: SessionTranscriptReadScope,
  readInWorker: (source: SessionTranscriptWorkerReadSource) => Promise<T>,
  signal?: AbortSignal,
  lane?: SessionHistoryWorkerLane,
  throughStorePath?: string,
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
  const storePath =
    captured.storePath ?? resolveOpenClawAgentSqlitePath({ agentId, env: captured.env });
  const selected = getOwnedSessionTranscriptReader(captured);
  const context = captureOpenClawStateReadWorkerContext({ env: captured.env });
  const readResolved = (
    resolved: ResolvedTranscriptReadScope & { path: string },
    identity: DatabasePathIdentity,
    assertSource: () => void,
    requestedPaths: readonly string[],
  ) => {
    const expectedIdentity = identity.key.startsWith("file:") ? identity : undefined;
    const readPath = expectedIdentity ? (throughStorePath ?? resolved.path) : resolved.path;
    const options = toDatabaseOptions({ ...resolved, path: readPath });
    return withSessionHistoryWorkerDatabase(
      { ...options, requestedPaths },
      async (owner) => {
        const assertCurrent = () => {
          assertSource();
          owner.assertCurrent();
        };
        assertCurrent();
        const preparedReads = expectedIdentity
          ? createPreparedSessionTranscriptReads({
              expectedIdentity,
              assertCurrent,
              reader: owner,
            })
          : undefined;
        return await readInWorker({
          scope: { ...captured, agentId: resolved.agentId, storePath: readPath },
          resolved,
          owner,
          preparedReads,
          expectedIdentity,
          assertCurrent,
        });
      },
      lane,
    );
  };
  if (selected) {
    const assertSource = () => {
      signal?.throwIfAborted();
      context.maintenanceScope?.assertAdmission();
      context.admission.assertCurrent();
      selected.assertCurrent();
    };
    assertSource();
    const identity = readDatabasePathIdentitySync(selected.database.path);
    if (!identity.key.startsWith("file:")) {
      throw new Error("Admitted transcript database is no longer available");
    }
    return await readResolved(
      {
        agentId: selected.logicalAgentId,
        databaseAgentId: selected.database.agentId,
        path: identity.canonicalPath,
        ownerStorePath: storePath,
        env: selected.database.env,
        sessionKey: selected.sessionKey,
        sessionId: captured.sessionId,
      },
      identity,
      assertSource,
      selected.storePaths,
    );
  }
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  return await withSessionHistoryWorkerReadCandidates(
    candidates,
    async (discovery) => {
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
      };
      assertSource();
      return await readResolved(
        { ...resolved, path: selectedIdentity.canonicalPath },
        selectedIdentity,
        assertSource,
        [storePath],
      );
    },
    lane,
  );
}
