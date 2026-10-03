import type { SessionLifecycleRevisionExpectation } from "../config/sessions/session-transcript-turn-lifecycle.types.js";
import { registerTranscriptSourceCommitRestriction } from "../config/sessions/transcript-source-commit-restrictions.js";
import type { DatabaseFileIdentity } from "../infra/sqlite-worker-identity.js";

type UserTurnPersistenceRestriction = {
  expectedSessionId?: string;
  expectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
};

/** Every caller shares the restrictions on this recorder's original input. */
export function createUserTurnPersistenceRestrictions(
  expectedLifecycleRevision?: SessionLifecycleRevisionExpectation,
) {
  let current: UserTurnPersistenceRestriction = { expectedLifecycleRevision };
  let sourceDatabase: DatabaseFileIdentity | undefined;

  const restrict = (next: UserTurnPersistenceRestriction) => {
    const expectedSessionId = next.expectedSessionId || undefined;
    if (
      (current.expectedSessionId !== undefined &&
        expectedSessionId !== undefined &&
        current.expectedSessionId !== expectedSessionId) ||
      (current.expectedLifecycleRevision !== undefined &&
        next.expectedLifecycleRevision !== undefined &&
        current.expectedLifecycleRevision !== next.expectedLifecycleRevision)
    ) {
      throw new Error("User turn source identity restrictions conflict before persistence.");
    }
    current = {
      expectedSessionId: current.expectedSessionId ?? expectedSessionId,
      expectedLifecycleRevision:
        current.expectedLifecycleRevision !== undefined
          ? current.expectedLifecycleRevision
          : next.expectedLifecycleRevision,
    };
  };

  return {
    restrict,
    restrictSourceDatabase: (identity: DatabaseFileIdentity) => {
      if (
        sourceDatabase &&
        (sourceDatabase.key !== identity.key || sourceDatabase.birthtime !== identity.birthtime)
      ) {
        throw new Error("User turn physical source restrictions conflict before persistence.");
      }
      sourceDatabase ??= Object.freeze({ ...identity });
    },
    capture(producerExpectedSessionId?: string, targetSessionId?: string) {
      const producerId = producerExpectedSessionId || undefined;
      if (
        current.expectedSessionId !== undefined &&
        producerId !== undefined &&
        current.expectedSessionId !== producerId
      ) {
        throw new Error("User turn source identity restrictions conflict before persistence.");
      }
      const submitted = {
        expectedSessionId: current.expectedSessionId ?? producerId,
        expectedLifecycleRevision: current.expectedLifecycleRevision,
      };
      const submittedSessionId = submitted.expectedSessionId ?? targetSessionId;
      const assertCurrent = () => {
        // A later join cannot add a condition to an already serialized transaction.
        if (
          (current.expectedSessionId !== undefined &&
            current.expectedSessionId !== submittedSessionId) ||
          (current.expectedLifecycleRevision !== undefined &&
            current.expectedLifecycleRevision !== submitted.expectedLifecycleRevision)
        ) {
          throw new Error("User turn source restrictions changed during persistence.");
        }
      };
      registerTranscriptSourceCommitRestriction(assertCurrent, () => sourceDatabase);
      return {
        ...submitted,
        assertCurrent,
      };
    },
  };
}
