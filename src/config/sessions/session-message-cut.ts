import {
  assertExistingDatabaseIdentity,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { invalidateSessionBranchCache } from "./session-accessor.sqlite-branches.js";
import {
  captureNativeSessionWorkerDeletion,
  hasPreparedNativeSessionDeletion,
  withSqliteSessionContextReset,
} from "./session-accessor.sqlite-deletion.js";
import type { retainPreparedSessionSharingFacts } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import { toDatabaseOptions, type ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import type { SessionMessageCutMutationParams } from "./session-accessor.types.js";
import { restoreSessionColdTranscript } from "./session-cold-storage.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { executeSessionForkOperation } from "./session-fork-domain.js";
import type {
  SessionMessageCutCandidate,
  SessionMessageCutIntent,
  SessionMessageCutResult,
} from "./session-message-cut.types.js";
import { runSessionNativeBindingWorkerOperation } from "./session-native-binding.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

export async function mutateSessionHistoryInWorker(
  params: SessionMessageCutMutationParams,
  resolved: ResolvedSqliteScope,
  intent: SessionMessageCutIntent,
  source: DatabasePathIdentity,
  native: (
    intent: SessionMessageCutIntent,
    assertCurrent: () => void,
  ) => Promise<SessionMessageCutResult>,
  selection?: ReturnType<typeof retainPreparedSessionSharingFacts>,
  sourceRepositoryWorkspaceId?: string,
): Promise<SessionMessageCutResult> {
  params.commitGuard?.();
  if (!source.key.startsWith("file:")) {
    return { status: "missing-session" };
  }
  const database = { ...toDatabaseOptions(resolved), path: source.canonicalPath };
  const assertCurrent = () => {
    assertExistingDatabaseIdentity(resolved.path ?? database.path, source.key, source.birthtime);
    params.commitGuard?.();
  };
  const preparedEntry = await withSessionEntryReadOnlyInWorker(
    {
      agentId: resolved.agentId,
      env: database.env,
      sessionKey: intent.sourceKey,
      storePath: database.path,
    },
    assertCurrent,
    async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      return read.value;
    },
  );
  if (!preparedEntry?.sessionId) {
    return { status: "missing-session" };
  }
  if (selection) {
    for (;;) {
      const pending = selection.prepareRead();
      if (!pending) {
        break;
      }
      await pending;
    }
    assertCurrent();
    try {
      // Reconcile the initial generation only; caller grants still own authority.
      selection.initialize({ entry: preparedEntry, membership: new Set<string>() });
    } catch {
      return { status: "conflict" };
    } finally {
      selection.release();
    }
  }
  const preparedIntent = {
    ...intent,
    expectedState: intent.expectedState ?? {
      sessionId: preparedEntry.sessionId,
      lifecycleRevision: preparedEntry.lifecycleRevision,
    },
  };
  await restoreSessionColdTranscript(
    {
      agentId: resolved.agentId,
      env: database.env,
      sessionKey: intent.sourceKey,
      storePath: database.path,
      sessionId: preparedEntry.sessionId,
    },
    assertCurrent,
  );
  assertCurrent();
  const prepareContext = (run: (assertCurrent: () => void) => Promise<SessionMessageCutResult>) =>
    intent.mode === "fork"
      ? run(() => {})
      : withSqliteSessionContextReset(
          resolved,
          { sessionKey: intent.sourceKey, entry: preparedEntry },
          run,
        );
  return prepareContext(async (assertPreparedCurrent) => {
    const assertHeld = () => {
      assertCurrent();
      assertPreparedCurrent();
    };
    const entries = [{ sessionKey: intent.sourceKey, entry: preparedEntry }];
    const captured =
      intent.mode === "fork" ? undefined : captureNativeSessionWorkerDeletion(entries);
    // Released opaque SDK hooks retain their synchronous transaction visibility.
    if (intent.mode !== "fork" && hasPreparedNativeSessionDeletion() && !captured) {
      return native(preparedIntent, assertHeld);
    }
    const operation: Omit<
      Parameters<
        typeof runSessionEntryWorkerOperation<SessionMessageCutCandidate, SessionMessageCutResult>
      >[0],
      "run"
    > = {
      database,
      databaseIdentity: source.key.slice("file:".length),
      agentId: resolved.agentId,
      assertCurrent: assertHeld,
      candidateKind: "session-message-cut" as const,
      onAcknowledged(candidate: SessionMessageCutCandidate) {
        if (candidate.result.status === "created") {
          captured?.committed();
          if (candidate.projectionNeedsReconcile) {
            startSessionTranscriptIndexReconcile({
              ...database,
              preferredSessionId: candidate.result.entry.sessionId,
            });
          }
          invalidateSessionBranchCache(database.path, [
            ...candidate.previousSessionIds,
            candidate.result.entry.sessionId,
          ]);
        }
      },
      onCommitted(candidate, published, identity) {
        if (published) {
          publishCommittedSessionIdentity(
            resolved.agentId,
            identity,
            published.previous,
            published.current,
            published.prepared,
          );
        }
        return candidate.result;
      },
    };
    if (intent.mode === "fork") {
      return runSessionEntryWorkerOperation<SessionMessageCutCandidate, SessionMessageCutResult>({
        ...operation,
        run: (worker, commit) =>
          commit(() =>
            executeSessionForkOperation(worker, database.agentId, {
              type: "session.messageCut.fork",
              input: {
                agentId: resolved.agentId,
                intent: { ...preparedIntent, mode: "fork" },
                sourceRepositoryWorkspaceId,
              },
            }),
          ),
      });
    }
    const input = {
      agentId: resolved.agentId,
      intent: { ...preparedIntent, mode: intent.mode },
    };
    if (captured) {
      return runSessionNativeBindingWorkerOperation<
        SessionMessageCutCandidate,
        SessionMessageCutResult
      >({
        ...operation,
        entries,
        captured,
        execute: (worker, nativeBindings) =>
          worker.execute({
            type: "session.messageCut.commit",
            input: { ...input, nativeBindings },
          }),
      });
    }
    return runSessionEntryWorkerOperation<SessionMessageCutCandidate, SessionMessageCutResult>({
      ...operation,
      run: (worker, commit) =>
        commit(() =>
          worker.execute({
            type: "session.messageCut.commit",
            input,
          }),
        ),
    });
  });
}
