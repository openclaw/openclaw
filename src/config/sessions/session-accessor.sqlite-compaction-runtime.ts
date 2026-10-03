import type { CommittedCompactionAppend } from "../../agents/sessions/session-compaction-persistence.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseAsync } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { persistCompactionBoundaryWithSessionEntrySync } from "./session-accessor.sqlite-compaction.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
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
  const options = toDatabaseOptions(resolveSqliteTranscriptScope(captured));
  const transcriptByteCompactionLatch = { ...params.transcriptByteCompactionLatch };
  return await trackAsyncWork(() =>
    runOpenClawAgentWriteAdmission(
      options,
      async () => {
        assertCurrent();
        if (isIncognitoSessionKey(captured.sessionKey)) {
          // Incognito retains its host-owned transaction until the worker activation cutover.
          return persistCompactionBoundaryWithSessionEntrySync(captured, {
            prepared,
            transcriptByteCompactionLatch,
          });
        }
        const { withSessionMetadataWorker } = await runInDetachedAsyncContext(
          () => import("../../agents/sessions/session-manager-metadata-runtime.js"),
        );
        assertCurrent();
        return await withOpenClawAgentDatabaseAsync(
          options,
          (database) =>
            withSessionMetadataWorker(options, database, assertCurrent, async (worker) => {
              const { env: _env, ...target } = captured;
              const { env: _preparedEnv, ...preparedTarget } = prepared.scope;
              const receipt = await worker.execute({
                type: "session.transcript.compactionBoundary",
                input: {
                  scope: target,
                  prepared: { ...prepared, scope: preparedTarget },
                  transcriptByteCompactionLatch,
                  ...(initialWriter && !initialWriter.committedFence
                    ? { initialWriterRunId: initialWriter.writerRunId }
                    : {}),
                },
              });
              try {
                if (receipt.initialEntry?.fence) {
                  initialWriter?.recordCommitted(receipt.initialEntry.fence);
                }
              } finally {
                if (receipt.initialEntry?.identity) {
                  publishCommittedSessionIdentity(
                    captured.agentId,
                    readOpenClawAgentDatabaseIdentity(database).identity,
                    receipt.initialEntry.identity.previous,
                    receipt.initialEntry.identity.current,
                  );
                }
              }
              if (receipt.projectionNeedsReconcile) {
                startSessionTranscriptIndexReconcile({
                  ...options,
                  preferredSessionId: captured.sessionId,
                });
              }
              return receipt.committed;
            }),
          assertCurrent,
        );
      },
      true,
    ),
  );
}
