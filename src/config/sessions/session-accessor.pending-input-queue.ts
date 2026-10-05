import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type { TurnRecoveryIntent } from "./main-session-recovery.types.js";
import {
  resolveSqliteWriteAdmissionScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  PendingInputQueueSnapshot,
  PendingInputQueueCandidate,
  CommittedRecoveryInput,
  CommittedRecoveryInputSnapshot,
} from "./session-pending-input-operations.types.js";
import { preparePendingInputStore, type PendingInputScope } from "./session-pending-input-store.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { InternalSessionEntry } from "./types.js";

export async function withSessionPendingInputQueue<T>(
  scope: PendingInputScope,
  assertCurrent: () => void,
  run: (operations: {
    readCommitted(): Promise<CommittedRecoveryInputSnapshot>;
    recoverCommitted(input: {
      expectedEntry: InternalSessionEntry;
      lifecycleGeneration: string;
      input: CommittedRecoveryInput;
      intent: TurnRecoveryIntent;
    }): Promise<{ entry: InternalSessionEntry } | undefined>;
    read(
      runId?: string,
      page?: { afterSeq?: number; throughSeq?: number },
    ): Promise<PendingInputQueueSnapshot>;
    cancel(
      expectedEntry: InternalSessionEntry,
      row: PendingInputQueueCandidate,
      assertCancellationCurrent: () => void,
    ): Promise<boolean>;
    promote(input: {
      expectedEntry: InternalSessionEntry;
      lifecycleGeneration: string;
    }): Promise<{ entry: InternalSessionEntry } | undefined>;
    recoverAccepted(input: {
      expectedEntry: InternalSessionEntry;
      lifecycleGeneration: string;
      row: PendingInputQueueCandidate;
    }): Promise<{ entry: InternalSessionEntry } | undefined>;
  }) => Promise<T>,
): Promise<T> {
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const admission = resolveSqliteWriteAdmissionScope(captured);
  const operation = async () => {
    assertCurrent();
    const store = await preparePendingInputStore(captured, assertCurrent);
    try {
      return await store.withAdmission(
        () =>
          run({
            async readCommitted() {
              if (isIncognitoSessionKey(scope.sessionKey)) {
                // Incognito keeps its existing memory-only accepted queue recovery.
                return { kind: "committed-recovery", current: true };
              }
              const result = await store.read({
                kind: "committed-recovery",
                sessionKey: store.sessionKey,
                sessionId: scope.sessionId,
              });
              assertCurrent();
              store.assertCurrent();
              if (result.kind !== "committed-recovery") {
                throw new Error("Committed input read returned a different operation");
              }
              return result;
            },
            async recoverCommitted(input) {
              if (isIncognitoSessionKey(scope.sessionKey)) {
                return undefined;
              }
              const result = await store.mutate(
                {
                  kind: "recover-committed",
                  sessionKey: store.sessionKey,
                  sessionId: scope.sessionId,
                  ...input,
                },
                assertCurrent,
              );
              if (result.operation !== "recover-committed") {
                throw new Error("Committed input recovery returned a different receipt");
              }
              return result.entry ? { entry: result.entry } : undefined;
            },
            async read(runId, page) {
              const snapshot = await store.read({
                kind: "queue",
                sessionKey: store.sessionKey,
                sessionId: scope.sessionId,
                runId,
                ...page,
              });
              assertCurrent();
              store.assertCurrent();
              if (snapshot.kind !== "queue") {
                throw new Error("Pending queue read returned a different operation");
              }
              return snapshot;
            },
            async cancel(expectedEntry, row, assertCancellationCurrent) {
              const result = await store.mutate(
                {
                  kind: "cancel-queued",
                  sessionKey: store.sessionKey,
                  sessionId: scope.sessionId,
                  lifecycleGeneration: getAgentEventLifecycleGeneration(),
                  expectedEntry,
                  row,
                },
                () => {
                  assertCurrent();
                  assertCancellationCurrent();
                },
              );
              if (result.operation !== "cancel-queued") {
                throw new Error("Pending queue cancellation returned a different receipt");
              }
              return result.changed;
            },
            async promote(input) {
              const result = await store.mutate(
                {
                  kind: "promote",
                  sessionKey: store.sessionKey,
                  sessionId: scope.sessionId,
                  ...input,
                },
                assertCurrent,
              );
              if (result.operation !== "promote") {
                throw new Error("Pending queue promotion returned a different receipt");
              }
              return result.entry ? { entry: result.entry } : undefined;
            },
            async recoverAccepted(input) {
              const result = await store.mutate(
                {
                  kind: "recover-accepted",
                  sessionKey: store.sessionKey,
                  sessionId: scope.sessionId,
                  ...input,
                },
                assertCurrent,
              );
              if (result.operation !== "recover-accepted") {
                throw new Error("Pending input recovery returned a different receipt");
              }
              return result.entry ? { entry: result.entry } : undefined;
            },
          }),
        admission !== undefined,
      );
    } finally {
      await store.release();
    }
  };
  return admission
    ? runOpenClawAgentWriteAdmission(toDatabaseOptions(admission), operation)
    : operation();
}

export function promoteQueuedSessionPendingInput(
  scope: PendingInputScope,
  input: { expectedEntry: InternalSessionEntry; lifecycleGeneration: string },
  assertCurrent: () => void,
): Promise<{ entry: InternalSessionEntry } | undefined> {
  return withSessionPendingInputQueue(scope, assertCurrent, (operations) =>
    operations.promote(input),
  );
}
