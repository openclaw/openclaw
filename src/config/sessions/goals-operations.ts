import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { assertSessionGoalOperationTime } from "./goals-operation-policy.js";
import { SessionGoalOperationError } from "./goals-operations.types.js";
import type {
  SessionGoalManagementInput,
  SessionTranscriptTurnMutationResult,
} from "./goals-operations.types.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import type { SessionEntry } from "./types.js";

export type { SessionGoalOperation, SessionGoalOperationResult } from "./goals-operations.types.js";
export { SessionGoalOperationError } from "./goals-operations.types.js";

/** Management-only Goal actions do not enter chat or fabricate user turns. */
export async function mutateSessionGoal(
  options: SessionAccessScope &
    SessionGoalManagementInput & {
      /** Revalidate the Gateway-owned authorization after waiting for the writer queue. */
      assertCurrent?: SessionSourceAssertion;
    },
): Promise<SessionTranscriptTurnMutationResult & { sessionEntry?: SessionEntry }> {
  const assertCurrent = () => options.assertCurrent?.();
  const authority = { assertCurrent, authorize: assertCurrent };
  const memory = captureSessionActorStorageOwner(options, authority);
  if (memory) {
    const result = await withSessionActorStorage(
      options,
      { lifetime: { assertCurrent, assertReadable: assertCurrent }, authority: memory.authority },
      async (binding) => {
        let authorityFailure: unknown;
        const outcome = await binding.actor.storage!.mutate(
          {
            type: "session.goal.mutate",
            input: {
              sessionKey: binding.actor.target.sessionKey,
              expectedSessionId: options.expectedSessionId,
              operation: options.operation,
            },
          },
          {
            ...binding.authority,
            assertCurrent() {
              try {
                binding.authority.assertCurrent();
              } catch (error) {
                authorityFailure = error;
                throw error;
              }
            },
            authorize(stage, facts, publication) {
              try {
                binding.authority.authorize(stage, facts, publication);
              } catch (error) {
                authorityFailure = error;
                throw error;
              }
            },
          },
        );
        if (outcome.kind === "rolled-back" && authorityFailure instanceof Error) {
          throw authorityFailure;
        }
        const committed = readSessionActorStorageResult(outcome);
        const { previous: _previous, ...receipt } = committed;
        return receipt;
      },
    );
    if (!result) {
      throw new SessionGoalOperationError(
        "session-rebound",
        "Session changed; refresh before changing its Goal.",
      );
    }
    return result;
  }
  const resolved = captureLifecycleDatabaseScope(resolveSqliteScope(options));
  const databaseOptions = toDatabaseOptions(resolved);
  const input = {
    sessionKey: resolved.sessionKey,
    expectedSessionId: options.expectedSessionId,
    operation: options.operation,
  };
  return runExclusiveSqliteSessionWrite(
    resolved,
    async () => {
      // The existing writer owns durable Goal changes and publishes them before FIFO release.
      const execution = captureOpenClawAgentDatabaseExecution(databaseOptions);
      const client = await import("./goals-management.js").catch(async (error: unknown) => {
        await execution.release();
        throw error;
      });
      return client.mutateSessionGoalInWorker(
        { ...databaseOptions, path: resolved.path },
        resolved.agentId,
        execution,
        input,
        composeSessionSourceAssertion([options.assertCurrent], (assertSources) => {
          assertSources();
          assertSessionGoalOperationTime(input.operation, Date.now());
        }),
      );
    },
    "session.goal.mutate",
  );
}
