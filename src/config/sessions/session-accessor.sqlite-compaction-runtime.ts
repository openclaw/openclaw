import type { CommittedCompactionAppend } from "../../agents/sessions/session-compaction-persistence.js";
import {
  captureSessionManagerIncognitoBinding,
  withSessionManagerMemoryActor,
} from "../../agents/sessions/session-manager-incognito-scope.js";
import { createSessionManagerMemoryDatabase } from "../../agents/sessions/session-manager-memory.js";
import {
  receiveSessionManagerCommit,
  SessionEntryCommittedError,
} from "../../agents/sessions/session-manager-persistence-error.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseRuntime } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type { persistCompactionBoundaryWithSessionEntrySync } from "./session-accessor.sqlite-compaction.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionManagerIncognitoDatabase } from "./session-manager-write-contract.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import {
  captureSessionTranscriptTargetBinding,
  sameSessionTranscriptStorageEnvironment,
} from "./transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptInitialWriter,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

/** Commit transcript and accounting together through the existing SessionManager writer. */
export async function persistCompactionBoundaryWithSessionEntryAsync(
  scope: Parameters<typeof persistCompactionBoundaryWithSessionEntrySync>[0],
  params: Parameters<typeof persistCompactionBoundaryWithSessionEntrySync>[1],
  assertActive?: () => void,
): Promise<CommittedCompactionAppend> {
  assertActive?.();
  const captured = withOwnedSessionTranscriptWriterFence({
    ...captureSessionTranscriptTargetBinding(scope),
    expectedLifecycleRevision: scope.expectedLifecycleRevision,
    expectedWriterRunId: scope.expectedWriterRunId,
    ...(scope.expectedOwner ? { expectedOwner: { ...scope.expectedOwner } } : {}),
  });
  const { scope: preparedScope, ...append } = params.prepared;
  const prepared = {
    ...structuredClone(append),
    scope: withOwnedSessionTranscriptWriterFence({
      ...captureSessionTranscriptTargetBinding(preparedScope),
      expectedLifecycleRevision: preparedScope.expectedLifecycleRevision,
      expectedWriterRunId: preparedScope.expectedWriterRunId,
      ...(preparedScope.expectedOwner ? { expectedOwner: { ...preparedScope.expectedOwner } } : {}),
    }),
  };
  if (!sameSessionTranscriptStorageEnvironment(captured.env, prepared.scope.env)) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const assertOwned = captureOwnedTranscriptWriteAssertion(captured);
  const assertPreparedOwned = captureOwnedTranscriptWriteAssertion(prepared.scope);
  const initialWriter = getOwnedSessionTranscriptInitialWriter({ sessionTarget: prepared.scope });
  const assertCurrent = () => {
    assertActive?.();
    assertOwned();
    assertPreparedOwned();
    initialWriter?.assertActive();
  };
  const memory = captureSessionManagerIncognitoBinding(captured);
  const options = memory?.database ?? toDatabaseOptions(resolveSqliteTranscriptScope(captured));
  const transcriptByteCompactionLatch = { ...params.transcriptByteCompactionLatch };
  const persist = async (database: OpenClawAgentDatabase | SessionManagerIncognitoDatabase) => {
    const { withSessionMetadataWorker } = await runInDetachedAsyncContext(
      () => import("../../agents/sessions/session-manager-metadata-runtime.js"),
    );
    assertCurrent();
    return withSessionMetadataWorker(
      options,
      database,
      assertCurrent,
      async (worker) => {
        const { env: _env, ...target } = captured;
        const { env: _preparedEnv, ...preparedTarget } = prepared.scope;
        const acknowledged = await receiveSessionManagerCommit(
          "session.transcript.compactionBoundary",
          () =>
            worker.execute({
              type: "session.transcript.compactionBoundary",
              input: {
                scope: memory ? { ...target, storePath: database.path } : target,
                prepared: {
                  ...prepared,
                  scope: memory ? { ...preparedTarget, storePath: database.path } : preparedTarget,
                },
                transcriptByteCompactionLatch,
                ...(initialWriter && !initialWriter.committedFence
                  ? { initialWriterRunId: initialWriter.writerRunId }
                  : {}),
              },
            }),
        );
        const receipt = acknowledged.value;
        if (acknowledged.failure) {
          throw new SessionEntryCommittedError(
            receipt.committed.result.id,
            captured,
            receipt.committed.after,
            acknowledged.failure,
          );
        }
        if (receipt.projectionNeedsReconcile) {
          startSessionTranscriptIndexReconcile({
            ...options,
            preferredSessionId: captured.sessionId,
          });
        }
        return receipt.committed;
      },
      { initialWriter },
    );
  };
  if (memory) {
    return trackAsyncWork(() =>
      withSessionManagerMemoryActor(
        memory,
        params.prepared.initializeEntry === true,
        async (selected) => {
          if (!selected) {
            throw new IncognitoSessionMissingError();
          }
          return persist(createSessionManagerMemoryDatabase(selected));
        },
      ),
    );
  }
  return trackAsyncWork(() =>
    runOpenClawAgentWriteAdmission(
      options,
      () => withOpenClawAgentDatabaseRuntime(options, persist, assertCurrent),
      true,
    ),
  );
}
