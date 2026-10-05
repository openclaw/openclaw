import { assertSessionGoalOperationTime } from "./goals-operations.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import {
  captureLifecycleDatabaseScope,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import type { SessionGoalCommitted, SessionGoalMutationPlan } from "./session-turn.types.js";

export async function mutateSessionGoalInWorker(
  requested: ResolvedSqliteScope,
  options: SessionGoalMutationPlan & { assertCurrent?: () => void },
): Promise<SessionGoalCommitted["result"]> {
  const scope = captureLifecycleDatabaseScope(requested);
  const database = { ...toDatabaseOptions(scope), path: scope.path };
  const plan: SessionGoalMutationPlan = {
    sessionKey: scope.sessionKey,
    expectedSessionId: options.expectedSessionId,
    operation: structuredClone(options.operation),
  };
  const assertCurrent = () => {
    options.assertCurrent?.();
    assertSessionGoalOperationTime(options.operation, Date.now());
  };
  return runSessionEntryWorkerOperation<SessionGoalCommitted, SessionGoalCommitted["result"]>({
    database,
    agentId: scope.agentId,
    assertCurrent,
    candidateKind: "session-goal",
    run(worker, commit) {
      return commit(() => worker.execute({ type: "session.turn.goal.commit", input: plan }));
    },
    onCommitted(candidate, published, identity) {
      if (published) {
        publishCommittedSessionIdentity(
          scope.agentId,
          identity,
          published.previous,
          published.current,
          published.prepared,
        );
      }
      return candidate.result;
    },
  });
}
