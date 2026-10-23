import {
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { acceptSessionSourceValidation } from "./session-source-authority.js";
import { projectionLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type {
  SqliteExpectedSessionTranscriptTurnResult,
  SqliteSessionTurnOptions,
} from "./session-turn.types.js";

/** Cold restoration changes storage before append, under the same selected owner. */
export async function restoreSessionTurnColdTranscript(
  scope: ResolvedTranscriptScope,
  options: SqliteSessionTurnOptions,
  assertCurrent: () => void,
  initialSessionEntry: SqliteSessionTurnOptions["initialSessionEntry"],
): Promise<SqliteExpectedSessionTranscriptTurnResult | undefined> {
  const {
    restoreSessionColdTranscript,
    SessionColdSourceReboundError,
    SessionColdTurnReboundError,
  } = await import("./session-cold-storage.js");
  const source = options.ownerSource;
  const sources = source?.checks.map(({ predicate }) => predicate);
  const guard =
    options.keyFormat === "agent-qualified" || sources?.length
      ? {
          kind: "turn" as const,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          options: {
            keyFormat: options.keyFormat,
            expectedSessionId: options.expectedSessionId,
            selectedSessionId: options.selectedSessionId,
            selectedLifecycleRevision: options.selectedLifecycleRevision,
            expectedLifecycleRevision: options.expectedLifecycleRevision,
            expectedWriterRunId: options.expectedWriterRunId,
            expectedSessionState: options.expectedSessionState,
            initialSessionEntry,
          },
          goalOperation: options.sessionTurnMutation?.operation,
          sources,
        }
      : undefined;
  const target = { ...scope, storePath: scope.path };
  assertCurrent();
  try {
    if (source && sources?.length) {
      await withSessionHistoryWorkerDatabase(
        toDatabaseOptions(scope),
        async (owner) => {
          const assertAllowed = () => {
            assertCurrent();
            owner.assertCurrent();
          };
          await restoreSessionColdTranscript(
            target,
            assertAllowed,
            {
              target: scope,
              acceptSourceValidation: (validation) =>
                acceptSessionSourceValidation(source, validation),
              readMetadata: async () =>
                (
                  await owner.readColdMetadata({
                    sessionId: scope.sessionId,
                    env: scope.env ?? process.env,
                  })
                ).archive,
            },
            guard,
          );
        },
        projectionLane,
      );
    } else {
      await restoreSessionColdTranscript(target, assertCurrent, undefined, guard);
    }
  } catch (error) {
    if (error instanceof SessionColdTurnReboundError) {
      return { ...error.result, sessionFile: options.sessionFile };
    }
    if (error instanceof SessionColdSourceReboundError) {
      source?.checks[error.refusal.index]?.refuse(error.refusal.facts);
    }
    throw error;
  }
  return undefined;
}
