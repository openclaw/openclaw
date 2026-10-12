import fs from "node:fs";
import path from "node:path";
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
                forceInProcess,
                plan: {
                  kind: "archive-publish-prepare",
                  databaseOptions,
                  materializedPlans: [],
                  archiveDirectory: resolveSqliteTranscriptArchiveDirectory(scope),
                  requested: requestedForPass,
                },
              });
              if (prepared.kind !== "archive-publish-prepare") {
                throw new Error("SQLite archive preparation returned another operation's result");
              }
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
              const recorded = await runSqliteSessionReclamation({
                assertCommitAllowed: assertOwnerCurrent,
                forceInProcess,
                plan: {
                  kind: "archive-publish-record",
                  databaseOptions,
                  materializedPlans: [],
                  results,
                  nowMs: Date.now(),
                },
              });
              if (recorded.kind !== "archive-publish-record") {
                throw new Error("SQLite archive recording returned another operation's result");
              }
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

/** Removes canonical rows only after retention has removed their derived files. */
export async function prunePublishedSessionArchivesByRetention(params: {
  nowMs?: number;
  rules: readonly { olderThanMs: number; reason: "deleted" | "reset" }[];
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">;
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
      const candidates = await archives.withWriter(archives.readRetentionCandidates);
      assertCurrent();
      const now = params.nowMs ?? Date.now();
      const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(params.scope);
      const removable = candidates.filter((row) => {
        const olderThanMs = rules.get(row.reason as "deleted" | "reset");
        if (olderThanMs === undefined || now - row.created_at <= olderThanMs) {
          return false;
        }
        const archivePath = path.resolve(archiveDirectory, row.archive_name);
        return (
          path.dirname(archivePath) === path.resolve(archiveDirectory) &&
          path.basename(archivePath) === row.archive_name &&
          !fs.existsSync(archivePath)
        );
      });
      if (removable.length === 0) {
        return 0;
      }
      return archives.withWriter(() => {
        assertCurrent();
        return archives.pruneRetention({ candidates: removable, archiveDirectory });
      });
    },
  );
}
