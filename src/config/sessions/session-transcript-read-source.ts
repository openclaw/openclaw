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
import { captureExistingOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import {
  createPreparedSessionTranscriptReads,
  type PreparedSessionTranscriptReads,
} from "./session-transcript-execution-read.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

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

/** Retain the original physical transcript through preparation, reading and consumption. */
export async function withSessionTranscriptReadSource<T>(
  scope: SessionTranscriptReadScope,
  readInProcess: (scope: SessionTranscriptReadScope) => T | Promise<T>,
  readInWorker: (source: SessionTranscriptWorkerReadSource) => Promise<T>,
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
  const exact = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  // A logical family needs worker-owned discovery before its physical owner is known.
  const execution =
    exact.agentId || exact.shared
      ? captureExistingOpenClawAgentDatabaseExecution({ path: exact.path, env: captured.env })
      : undefined;
  let releaseStarted = false;
  const releaseExecution = () => {
    releaseStarted = true;
    return execution?.release();
  };
  try {
    const claim = execution?.capturePreparedGenerationClaim();
    return await withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
      try {
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
        const result = await withSessionHistoryWorkerDatabase(
          { ...options, requestedPaths: [storePath] },
          async (owner) => {
            const assertCurrent = () => {
              assertSource();
              owner.assertCurrent();
              claim?.assertCurrent();
            };
            const expectedIdentity = selectedIdentity.key.startsWith("file:")
              ? selectedIdentity
              : undefined;
            if (claim && (!expectedIdentity || execution?.agentId !== options.agentId)) {
              throw new Error("Transcript discovery changed its prepared execution owner");
            }
            const preparedReads =
              execution && claim && expectedIdentity
                ? createPreparedSessionTranscriptReads({
                    execution,
                    claim,
                    expectedIdentity,
                    assertCurrent,
                  })
                : undefined;
            try {
              return await readInWorker({
                scope: { ...captured, agentId: resolved.agentId, storePath: databasePath },
                resolved: { ...resolved, path: databasePath },
                owner,
                preparedReads,
                expectedIdentity,
                assertCurrent,
              });
            } finally {
              assertCurrent();
            }
          },
        );
        // Keep alias revocation registered until the borrowed execution has settled.
        if (execution) {
          await releaseExecution();
        }
        assertSource();
        return result;
      } finally {
        if (execution && !releaseStarted) {
          await releaseExecution();
        }
      }
    });
  } finally {
    if (execution && !releaseStarted) {
      await releaseExecution();
    }
  }
}
