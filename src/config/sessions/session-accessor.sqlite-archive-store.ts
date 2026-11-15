import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withSqliteTranscriptArchiveSession } from "./session-accessor.sqlite-archive-session.js";
import { readPendingSqliteTranscriptArchivesInWorker } from "./session-accessor.sqlite-archive.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import {
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import {
  publishPreparedSessionStateArchives,
  publishSessionStateArchivesInWorker,
} from "./session-archive-publication.js";
import { ARCHIVE_RETENTION_BATCH_SIZE } from "./session-history-archive-pruning.types.js";

/** Publishes derived archive files after their canonical rows and deletions commit. */
export async function publishSessionStateArchives(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "ownerStorePath" | "path">,
  requested: readonly SessionLifecycleArchivedTranscript[],
  assertSourceCurrent?: () => void,
): Promise<SessionLifecycleArchivedTranscript[]> {
  assertSourceCurrent?.();
  const databaseOptions = resolveSessionReclamationDatabaseOptions(toDatabaseOptions(scope));
  const forceInProcess = !supportsOpenClawAgentDatabaseExecution(databaseOptions);
  return withSqliteMutationWorkerLifetime(databaseOptions, (lifetime) => {
    const { signal } = lifetime;
    const assertCurrent = () => {
      lifetime.assertCurrent();
      assertSourceCurrent?.();
    };
    return withSqliteTranscriptArchiveSession(databaseOptions, async () => {
      if (!forceInProcess && requested.length === 0) {
        try {
          const pending = await readPendingSqliteTranscriptArchivesInWorker(
            {
              agentId: databaseOptions.agentId,
              databasePath: databaseOptions.path,
              env: databaseOptions.env,
            },
            signal,
          );
          assertCurrent();
          if (!pending) {
            return [...requested];
          }
        } catch {
          // Uncertain reads retain the canonical writable preparation path.
          assertCurrent();
        }
      }
      if (!forceInProcess) {
        return publishSessionStateArchivesInWorker({
          scope: { ...scope, path: databaseOptions.path },
          requested,
          assertCurrent,
          signal,
        });
      }
      const retained = await runExclusiveSqliteSessionWrite(
        scope,
        async () => {
          assertCurrent();
          openOpenClawAgentDatabase(databaseOptions);
          const source = retainOpenClawAgentDatabaseReadOnly(databaseOptions);
          if (!source.found) {
            throw new Error("SQLite archive publication lost its prepared database");
          }
          return source;
        },
        "session.archive.publish-prepare",
        undefined,
        "foreground",
        signal,
      );
      const { database, claim } = retained;
      const assertOwnerCurrent = () => {
        assertCurrent();
        claim.assertCurrent();
        if (!isOpenClawAgentDatabasePathCurrent(database)) {
          throw new Error("SQLite archive publication database was replaced");
        }
      };
      let result: SessionLifecycleArchivedTranscript[];
      try {
        const retainedIdentity = readOpenClawAgentDatabaseIdentity(database);
        const preparedDatabasePath = path.resolve(
          forceInProcess ? database.path : retainedIdentity.filename,
        );
        result = await publishPreparedSessionStateArchives(
          requested,
          {
            async prepare(requestedForPass) {
              assertOwnerCurrent();
              const prepared = await runSqliteSessionReclamation({
                assertCommitAllowed: assertOwnerCurrent,
                plan: {
                  kind: "archive-publish-prepare",
                  databaseOptions,
                  materializedPlans: [],
                  archiveDirectory: resolveSqliteTranscriptArchiveDirectory(scope),
                  requested: requestedForPass,
                },
              });
              assertOwnerCurrent();
              for (const plan of prepared.value) {
                if (
                  plan.agentId !== database.agentId ||
                  path.resolve(plan.databasePath) !== preparedDatabasePath
                ) {
                  throw new Error("SQLite archive preparation changed its retained database owner");
                }
                // Reclamation uses the native filename; the archive session retains the caller's spelling.
                plan.databasePath = databaseOptions.path;
                plan.databaseIdentity =
                  typeof retainedIdentity.identity === "string"
                    ? retainedIdentity.identity
                    : undefined;
              }
              return prepared.value;
            },
            async record(results) {
              assertOwnerCurrent();
              await runSqliteSessionReclamation({
                assertCommitAllowed: assertOwnerCurrent,
                plan: {
                  kind: "archive-publish-record",
                  databaseOptions,
                  materializedPlans: [],
                  results,
                  nowMs: Date.now(),
                },
              });
            },
          },
          signal,
        );
      } catch (operationError) {
        try {
          claim.release();
        } catch (releaseError) {
          throw createSqliteLifecycleAggregateError(
            [operationError, releaseError],
            "SQLite archive publication and retained claim release both failed",
            operationError,
          );
        }
        throw operationError;
      }
      claim.release();
      return result;
    });
  });
}

/** The archive owner expires published files and rows together, preserving live references. */
export async function prunePublishedSessionArchivesByRetention(params: {
  nowMs?: number;
  rules: readonly { olderThanMs: number; reason: "deleted" | "reset" }[];
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">;
  assertCurrent?: () => void;
}): Promise<number> {
  const rules = new Map(
    params.rules
      .filter((rule) => Number.isFinite(rule.olderThanMs) && rule.olderThanMs >= 0)
      .map((rule) => [rule.reason, rule.olderThanMs] as const),
  );
  if (rules.size === 0) {
    return 0;
  }
  return withSqliteSessionPageReclamation(
    toDatabaseOptions(params.scope),
    async (_reclaim, assertCurrent, _options, archives) => {
      const now = params.nowMs ?? Date.now();
      const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(params.scope);
      let removed = 0;
      let offset = 0;
      // Drain bounded pages so an older retained prefix cannot starve later eligible rows.
      while (true) {
        const candidates = await archives.readRetentionCandidates(offset);
        assertCurrent();
        if (candidates.length === 0) {
          break;
        }
        const removable = candidates.filter((row) => {
          const olderThanMs = rules.get(row.reason as "deleted" | "reset");
          return olderThanMs !== undefined && now - row.created_at > olderThanMs;
        });
        let removedFromPage = 0;
        // Small reference sets use narrowed rechecks; each batch returns FIFO custody.
        for (let batch = 0; batch < removable.length; batch += 16) {
          if (batch > 0) {
            await setImmediate();
          }
          removedFromPage += await archives.withWriter(() => {
            assertCurrent();
            return archives.pruneRetention({
              candidates: removable.slice(batch, batch + 16),
              archiveDirectory,
            });
          });
        }
        removed += removedFromPage;
        // Remaining rows shift forward; skip only the intentionally retained prefix.
        offset += candidates.length - removedFromPage;
        if (candidates.length < ARCHIVE_RETENTION_BATCH_SIZE) {
          break;
        }
      }
      const { cleanupArchivedSessionTranscripts } =
        await import("../../gateway/session-archive.runtime.js");
      await cleanupArchivedSessionTranscripts({
        directories: [archiveDirectory],
        rules: params.rules,
        nowMs: now,
        removeFile: (filePath) =>
          archives.withWriter(async () => {
            assertCurrent();
            if ((await archives.removeLegacy(filePath)) === "failed") {
              throw new Error(
                "Session archive retention could not remove a legacy file; retry maintenance",
              );
            }
          }),
      });
      return removed;
    },
    params.assertCurrent,
  );
}
