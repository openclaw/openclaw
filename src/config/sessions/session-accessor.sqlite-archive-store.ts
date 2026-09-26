import fs from "node:fs";
import path from "node:path";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { withSqliteTranscriptArchiveSession } from "./session-accessor.sqlite-archive-session.js";
import {
  transcriptArchiveIdentityKey,
  uniqueTranscriptArchives,
} from "./session-accessor.sqlite-archive-store-kernel.js";
import type {
  TranscriptArchivePublishPlan,
  TranscriptArchivePublishResult,
} from "./session-accessor.sqlite-archive-types.js";
import {
  readPendingSqliteTranscriptArchivesInWorker,
  runSqliteTranscriptArchivePublishWorker,
} from "./session-accessor.sqlite-archive.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import { hasPreparedNativeSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  resolveSessionReclamationDatabaseOptions,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";

type SessionArchivePublicationStorage = {
  prepare(
    requested: readonly SessionLifecycleArchivedTranscript[],
  ): Promise<TranscriptArchivePublishPlan[]>;
  record(results: readonly TranscriptArchivePublishResult[]): Promise<void>;
};

/** Publishes derived archive files after their canonical rows and deletions commit. */
export async function publishSessionStateArchives(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  requested: readonly SessionLifecycleArchivedTranscript[],
  storage?: SessionArchivePublicationStorage,
): Promise<SessionLifecycleArchivedTranscript[]> {
  if (storage) {
    return publishPreparedSessionStateArchives(requested, storage);
  }
  const databaseOptions = resolveSessionReclamationDatabaseOptions(toDatabaseOptions(scope));
  const forceInProcess =
    hasPreparedNativeSessionDeletion() || !supportsOpenClawAgentDatabaseExecution(databaseOptions);
  return withSqliteMutationWorkerLifetime(databaseOptions, ({ assertCurrent, signal }) =>
    withSqliteTranscriptArchiveSession(databaseOptions, async () => {
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
    }),
  );
}

async function publishPreparedSessionStateArchives(
  requested: readonly SessionLifecycleArchivedTranscript[],
  storage: SessionArchivePublicationStorage,
  signal?: AbortSignal,
): Promise<SessionLifecycleArchivedTranscript[]> {
  const requestedArchives = uniqueTranscriptArchives(requested);
  const requestedIdentitySet = new Set(
    requestedArchives.map((archive) =>
      transcriptArchiveIdentityKey(archive.sessionId, archive.generation),
    ),
  );
  let includeRequested = true;
  while (true) {
    const requestedForPass = includeRequested ? requestedArchives : [];
    const plans = await storage.prepare(requestedForPass);
    includeRequested = false;
    if (plans.length === 0) {
      break;
    }

    const results = await runSqliteTranscriptArchivePublishWorker(plans, signal);
    await storage.record(results);

    const planByIdentity = new Map(
      plans.map((plan) => [transcriptArchiveIdentityKey(plan.sessionId, plan.generation), plan]),
    );
    emitArchivedTranscriptUpdates(
      results.flatMap((result) => {
        const identity = transcriptArchiveIdentityKey(result.sessionId, result.generation);
        if (!result.archivedPath || requestedIdentitySet.has(identity)) {
          return [];
        }
        const plan = planByIdentity.get(identity);
        return plan
          ? [
              {
                archivedPath: result.archivedPath,
                generation: result.generation,
                sessionId: result.sessionId,
                sourcePath: path.join(plan.archiveDirectory, `${result.sessionId}.jsonl`),
              },
            ]
          : [];
      }),
    );
    const failedIds = results.flatMap((result) => (result.archivedPath ? [] : [result.sessionId]));
    if (failedIds.length > 0) {
      throw new Error(
        `Session deletion committed, but ${failedIds.length} transcript archive file export(s) remain pending in SQLite; retry the operation to publish them.`,
      );
    }
  }
  return [...requested];
}

const ARCHIVE_RETENTION_BATCH_SIZE = 256;

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
  const candidates = await runExclusiveSqliteSessionWrite(
    params.scope,
    async () => {
      const database = openOpenClawAgentDatabase(toDatabaseOptions(params.scope));
      if (!tableExists(database.db, "session_transcript_archives")) {
        return [];
      }
      const db = getSessionKysely(database.db);
      return executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_transcript_archives")
          .select([
            "archive_name",
            "created_at",
            "generation",
            "published_at",
            "reason",
            "session_id",
          ])
          .where("published_at", "is not", null)
          .orderBy("created_at", "asc")
          .orderBy("session_id", "asc")
          .orderBy("generation", "asc")
          .limit(ARCHIVE_RETENTION_BATCH_SIZE),
      ).rows;
    },
    "session.archive.retention-prepare",
  );
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
  return await runExclusiveSqliteSessionWrite(
    params.scope,
    async () => {
      let removed = 0;
      runOpenClawAgentWriteTransaction((transactionDb) => {
        const db = getSessionKysely(transactionDb.db);
        for (const row of removable) {
          const result = executeSqliteQuerySync(
            transactionDb.db,
            db
              .deleteFrom("session_transcript_archives")
              .where("session_id", "=", row.session_id)
              .where("generation", "=", row.generation)
              .where("archive_name", "=", row.archive_name)
              .where("created_at", "=", row.created_at)
              .where("published_at", "=", row.published_at),
          );
          removed += Number(result.numAffectedRows ?? 0n);
        }
      }, toDatabaseOptions(params.scope));
      return removed;
    },
    "session.archive.retention-commit",
  );
}
