import path from "node:path";
import {
  readDatabasePathIdentity,
  type DatabaseFileIdentity,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteDatabaseScopeIdentity } from "./session-accessor.sqlite-read-scope.js";
import {
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import {
  captureSessionStoreCandidateIdentities,
  type SessionStoreReadCustody,
} from "./session-store-read-candidates.js";
import { withSessionStoreTarget } from "./session-store-target-runtime.js";
import {
  createPreparedSessionTranscriptReads,
  type PreparedSessionTranscriptReads,
} from "./session-transcript-execution-read.js";
import {
  historyLane,
  prepareSessionStoreCandidatesInWorker,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker-runtime.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
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
    readCustody?: readonly SessionStoreReadCustody[],
  ) => {
    const expectedIdentity = identity.key.startsWith("file:") ? identity : undefined;
    const readPath = expectedIdentity ? (throughStorePath ?? resolved.path) : resolved.path;
    const options = toDatabaseOptions({ ...resolved, path: readPath });
    return withSessionHistoryWorkerDatabase(
      {
        ...options,
        requestedPaths,
        // Missing stores keep their ordered first-creation path; existing reads retain their source.
        ...(expectedIdentity ? { readIdentity: expectedIdentity, readCustody } : {}),
      },
      async (owner) => {
        const assertCurrent = () => {
          assertSource();
          owner.assertCurrent();
        };
        assertCurrent();
        const preparedReads = expectedIdentity
          ? createPreparedSessionTranscriptReads({
              expectedIdentity,
              readCustody,
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
    const identity = selected.identity;
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
  const assertCaptured = () => {
    signal?.throwIfAborted();
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  assertCaptured();
  const { candidates } = await prepareSessionStoreCandidatesInWorker({ storePath });
  assertCaptured();
  const identities = captureSessionStoreCandidateIdentities(candidates);
  // Absence is a first-creation fact, not a ban on an exact path's queued creator.
  const locatorCandidates = candidates.map((candidate) =>
    candidate.identity && !candidate.identity.key.startsWith("file:")
      ? { ...candidate, identity: undefined }
      : candidate,
  );
  const { effectiveAgentId, effectiveStorePath, effectiveEnv } =
    resolveSqliteDatabaseScopeIdentity(captured);
  return await withSessionStoreTarget(
    {
      agentId: effectiveAgentId,
      defaultAgentId: captured.defaultAgentId,
      storePath: effectiveStorePath ?? storePath,
      env: effectiveEnv ?? captured.env,
      candidates: locatorCandidates,
    },
    async (target, discovery) => {
      const original = identities.get(target.database.path);
      const identity = original ?? (await readDatabasePathIdentity(target.sourcePath));
      if (
        !original &&
        (identity.key.startsWith("file:") || identity.canonicalPath !== target.database.path)
      ) {
        throw new Error("Transcript read changed its captured database owner");
      }
      const assertSource = () => {
        assertCaptured();
        discovery.assertCurrent();
      };
      assertSource();
      return await readResolved(
        {
          agentId: target.logicalAgentId,
          databaseAgentId: target.database.agentId,
          path: identity.canonicalPath,
          ownerStorePath: effectiveStorePath,
          env: effectiveEnv,
          sessionKey: captured.sessionKey
            ? normalizeStoreSessionKey(captured.sessionKey)
            : undefined,
          sessionId: captured.sessionId,
        },
        identity,
        assertSource,
        [storePath],
        identity.key.startsWith("file:")
          ? [{ sourcePath: target.sourcePath, candidates }]
          : undefined,
      );
    },
    assertCaptured,
    undefined,
    signal,
    lane ?? historyLane,
  );
}
