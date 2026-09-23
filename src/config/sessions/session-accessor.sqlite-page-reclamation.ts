import { publishSqliteWalCheckpointObservation } from "../../infra/sqlite-wal-checkpoint.js";
import type { SqliteWalReclamationResult } from "../../infra/sqlite-wal.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { runPreparedSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { withSqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import {
  runExclusiveSqliteSessionWrite,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";

export type SqliteSessionPageReclaimer = (maxPages?: number) => Promise<SqliteWalReclamationResult>;

/** Acquire the archive worker before the caller's writer, so retained work cannot deadlock it. */
export async function withSqliteSessionPageReclamation<T>(
  input: OpenClawAgentDatabaseOptions,
  run: (reclaim: SqliteSessionPageReclaimer) => Promise<T>,
): Promise<T> {
  const options = resolveSessionReclamationDatabaseOptions(input);
  if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
    return run(async (maxPages) =>
      withSqliteSessionDatabase(options, (database) =>
        database.walMaintenance.reclaimFreePages({ maxPages }),
      ),
    );
  }
  return withSqliteMutationWorkerLifetime(options, async ({ assertCurrent, signal }) => {
    const retained = await runExclusiveSqliteSessionWrite(
      options,
      async () => {
        assertCurrent();
        return retainOpenClawAgentDatabaseReadOnly(options);
      },
      "session.reclamation.retain",
    );
    if (!retained.found) {
      throw new Error("SQLite page reclamation lost its prepared database");
    }
    let { database, claim } = retained;
    const physicalIdentity = claim.identity;
    const databaseOptions = {
      ...options,
      path: readOpenClawAgentDatabaseIdentity(database).filename,
    };
    try {
      return await withSqliteReclamationWorker(
        databaseOptions,
        claim,
        (worker) =>
          run((maxPages) =>
            withSqliteMutationWorkerLifetime(databaseOptions, async (request) => {
              const assertRequestCurrent = () => {
                assertCurrent();
                request.assertCurrent();
              };
              assertRequestCurrent();
              if (!claim.isCurrent()) {
                // Archive-file I/O may retire the borrowed host handle; keep the same physical store.
                const reopened = retainOpenClawAgentDatabaseReadOnly(databaseOptions);
                if (!reopened.found) {
                  throw new Error("SQLite page reclamation lost its prepared database");
                }
                if (reopened.claim.identity !== physicalIdentity) {
                  reopened.claim.release();
                  throw new Error("SQLite page reclamation database path was replaced");
                }
                claim.release();
                ({ database, claim } = reopened);
              }
              const result = await runPreparedSqliteSessionReclamation(
                {
                  plan: {
                    kind: "maintenance-pages",
                    databaseOptions,
                    materializedPlans: [],
                    maxPages,
                  },
                },
                {
                  database,
                  claim,
                  worker,
                  commitGate: request.commitGate,
                  assertRequestCurrent,
                },
              );
              if (result.kind !== "maintenance-pages") {
                throw new Error("SQLite page reclamation returned another operation's result");
              }
              if (result.value.checkpoint) {
                result.value.checkpoint = publishSqliteWalCheckpointObservation(
                  databaseOptions.path,
                  result.value.checkpoint,
                );
              }
              return result.value;
            }),
          ),
        assertCurrent,
        signal,
      );
    } finally {
      claim.release();
    }
  });
}
