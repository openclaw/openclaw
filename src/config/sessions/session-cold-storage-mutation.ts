import { sessionChanges } from "../../sessions/session-row-changes.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { toAgentExecutionConstraints } from "../../state/openclaw-agent-execution-scope.js";
import {
  captureOpenClawAgentDatabaseExecutionAsync,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { runSqliteTranscriptArchiveWorkerOperation } from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import { withSqliteReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import type { SessionColdReadPreparation } from "./session-cold-storage-read.js";
import type {
  SessionColdMutationPlan,
  SessionColdWorkerData,
} from "./session-cold-storage-worker.js";
import type { SessionColdMutationResult, SessionColdSource } from "./session-cold-storage.types.js";
import { reclaimSqliteFreePages } from "./session-history-archive-pruning.js";
import type { SessionSourceValidation } from "./session-source-authority.js";
import { createSessionSourceConversationMatches } from "./session-source-conversation-matches.js";
import { publishUnchangedSessionTranscriptReceipts } from "./session-transcript-authority.js";
import { createSessionWorkerExecutionSource } from "./session-worker-execution-source.js";

export async function runColdMutation(
  plan: SessionColdMutationPlan,
  source: SessionColdSource,
  assertCurrent?: () => void,
  callerSignal?: AbortSignal,
  acceptSourceValidation?: SessionColdReadPreparation["acceptSourceValidation"],
): Promise<SessionColdMutationResult> {
  const sourceMatches =
    plan.kind === "cold-restore" && plan.guard?.sources
      ? createSessionSourceConversationMatches(plan.guard.sources)
      : undefined;
  return await withSqliteMutationWorkerLifetime(
    plan.databaseOptions,
    async ({ assertCurrent: assertRequestCurrent, commitGate, signal }) => {
      const execution = supportsOpenClawAgentDatabaseExecution(plan.databaseOptions)
        ? await captureOpenClawAgentDatabaseExecutionAsync(
            plan.databaseOptions,
            toAgentExecutionConstraints(source.readIdentity),
          )
        : undefined;
      let retained: ReturnType<typeof retainOpenClawAgentDatabaseReadOnly> | undefined;
      try {
        const assertOpeningCurrent = () => {
          assertRequestCurrent();
          assertCurrent?.();
        };
        if (plan.kind === "cold-sweep" && execution) {
          // Derived FTS cleanup can reuse the canonical writer. Offline maintenance
          // keeps its existing exclusive-custody worker path below.
          const admitted = createSessionWorkerExecutionSource(
            assertOpeningCurrent,
            "Cold transcript cleanup retired",
            source.readCustody,
          );
          return await runExclusiveSqliteSessionWrite(
            plan.databaseOptions,
            async () => {
              const sweep = await execution.runExisting(admitted, (worker) =>
                worker.execute({
                  type: "session.cold.sweep",
                  input: {
                    sessionId: plan.sessionId,
                    afterSeq: plan.afterSeq,
                    maxRows: plan.maxRows,
                  },
                }),
              );
              if (!sweep) {
                throw new Error("Cold transcript cleanup lost its database");
              }
              return {
                archivedTranscripts: 0,
                externalizedTranscripts: 0,
                restored: false,
                sweep,
              };
            },
            "session.cold.sweep",
            { kind: "cold-sweep" },
            "worker",
            signal,
          );
        }
        if (!execution) {
          retained = await runExclusiveSqliteSessionWrite(
            plan.databaseOptions,
            async () => {
              assertOpeningCurrent();
              return retainOpenClawAgentDatabaseReadOnly(plan.databaseOptions);
            },
            "session.reclamation.retain",
            undefined,
            "foreground",
            signal,
          );
        }
        const executionClaim = execution
          ? await withSessionEntryWorker(
              plan.databaseOptions,
              undefined,
              assertOpeningCurrent,
              (owner, admitted) =>
                owner.runExisting(admitted, async () => owner.captureGenerationClaim()),
              undefined,
              execution,
              signal,
            )
          : undefined;
        const claim = executionClaim ?? (retained?.found ? retained.claim : undefined);
        if (!claim || `file:${claim.identity}` !== source.readIdentity.key) {
          throw new Error("Cold transcript operation lost its owning database");
        }
        const assertAllowed = () => {
          claim.assertCurrent();
          assertRequestCurrent();
          assertCurrent?.();
        };
        const diagnostics: SqliteSessionReclamationDiagnostics = { kind: plan.kind };
        const [completed] = await withSqliteReclamationAuthorization(
          commitGate,
          retained?.found ? retained.database.db : plan.databaseOptions.path,
          () => {
            if (sourceMatches?.length) {
              if (!acceptSourceValidation) {
                throw new Error("Cold restoration requires source validation acceptance");
              }
              const validation: SessionSourceValidation = {
                conversationMatches: sourceMatches.map(({ index, matches }) => {
                  if (Atomics.load(matches, 0) !== 1) {
                    throw new Error("Cold restoration source alternatives are not ready");
                  }
                  return {
                    index,
                    alternatives: Array.from(
                      { length: matches.length - 1 },
                      (_, alternative) => alternative,
                    ).filter((alternative) => Atomics.load(matches, alternative + 1) === 1),
                  };
                }),
              };
              acceptSourceValidation(validation);
              assertAllowed();
              for (const match of validation.conversationMatches) {
                const matches = sourceMatches.find(({ index }) => index === match.index)!.matches;
                const accepted = match.acceptedAlternatives ?? match.alternatives;
                for (let alternative = 0; alternative < matches.length - 1; alternative++) {
                  Atomics.store(matches, alternative + 1, accepted.includes(alternative) ? 1 : 0);
                }
              }
              return;
            }
            assertAllowed();
          },
          (authorize) =>
            runSqliteTranscriptArchiveWorkerOperation<{
              result: SessionColdMutationResult;
              cleanupIncomplete?: boolean;
            }>({
              diagnostics,
              signal,
              assertCurrent: assertAllowed,
              expectedMessageType: "reclaimed",
              validationOwner: executionClaim
                ? {
                    source: {
                      ...plan.databaseOptions,
                      canonicalPath: source.readIdentity.canonicalPath,
                    },
                    claim: executionClaim,
                  }
                : retained?.found
                  ? { database: retained.database, isCurrent: retained.claim.isCurrent }
                  : undefined,
              onCommitRequest: authorize,
              withWriteAdmission: async (run, reclamationAdmission) =>
                runExclusiveSqliteSessionWrite(
                  plan.databaseOptions,
                  async () => {
                    let refusal: { error: unknown } | undefined;
                    try {
                      assertAllowed();
                    } catch (error) {
                      refusal = { error };
                    }
                    await run(refusal);
                  },
                  "session.reclamation.worker-commit",
                  { ...diagnostics, reclamationAdmission },
                  "worker",
                  signal,
                ),
              workerData: {
                plan,
                source,
                executionAuthority: executionClaim?.authority,
                commitGate,
                sourceMatches,
              } satisfies SessionColdWorkerData,
            }),
        );
        if (!completed || completed.cleanupIncomplete) {
          throw new Error(
            "Cold transcript worker cleanup is incomplete; restart OpenClaw before another maintenance operation",
          );
        }
        publishUnchangedSessionTranscriptReceipts(completed.result.transcriptPublication);
        if (plan.kind === "cold-maintain") {
          await withSqliteSessionPageReclamation(
            plan.databaseOptions,
            (reclaimPages) =>
              reclaimSqliteFreePages(plan.databaseOptions, undefined, {
                reclaimPages,
                maxPages: 64 * 512,
                assertCurrent: assertAllowed,
              }),
            assertAllowed,
            source,
          );
        } else if (
          completed.result.restored &&
          completed.result.sessionKey !== undefined &&
          (executionClaim || (retained?.found && retained.claim.isCurrent()))
        ) {
          assertAllowed();
          // Receipt publications update facts only; display readers also need the committed notification.
          sessionChanges.emit({
            storePath: retained?.found ? retained.database.path : plan.databaseOptions.path,
            sessionKey: completed.result.sessionKey,
            scope: "transcript",
            facts: { kind: "unchanged" },
          });
        }
        return completed.result;
      } finally {
        await execution?.release();
        if (retained?.found) {
          retained.claim.release();
        }
      }
    },
    callerSignal,
  );
}
