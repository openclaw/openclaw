import path from "node:path";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  isSqliteCorruptionError,
  runSqliteDeferredTransactionSync,
} from "../infra/sqlite-transaction.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";

type RetainedAgentDeletion = {
  agentId: string;
  databasePaths: readonly string[];
  state: "pending" | "retained";
  warning?: string;
};

type RetainedAgentDeletionReadFailure = { status: "unavailable"; warning?: string };

export type RetainedAgentDeletionDisposition =
  | readonly RetainedAgentDeletion[]
  | { status: "absent" }
  | RetainedAgentDeletionReadFailure;

export function retainedAgentDeletionHistoryUnavailable(
  disposition: RetainedAgentDeletionDisposition,
): disposition is RetainedAgentDeletionReadFailure {
  return "status" in disposition && disposition.status === "unavailable";
}

export function retainedAgentDeletionHistoryAbsent(
  disposition: RetainedAgentDeletionDisposition,
): disposition is { status: "absent" } {
  return "status" in disposition && disposition.status === "absent";
}

export function retainedAgentDeletionReadWarning(
  disposition: RetainedAgentDeletionDisposition,
): string | undefined {
  if (retainedAgentDeletionHistoryUnavailable(disposition)) {
    return disposition.warning;
  }
  if (retainedAgentDeletionHistoryAbsent(disposition)) {
    return undefined;
  }
  const warnings = [...new Set(disposition.flatMap((entry) => entry.warning ?? []))];
  return warnings.length > 0 ? warnings.join(" ") : undefined;
}

function parseDatabasePaths(value: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed;
    }
  } catch {
    // The readable identity still fences this deletion below.
  }
  return undefined;
}

/** Read deletions that currently revoke database writes without mutating journal history. */
export function readRetainedAgentDeletions(
  env: NodeJS.ProcessEnv,
): RetainedAgentDeletionDisposition {
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => {
          if (!tableExists(db, "agent_deletion_journal")) {
            return { status: "unavailable" as const };
          }
          const database =
            getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "agent_deletion_journal">>(db);
          return runSqliteDeferredTransactionSync(db, () =>
            executeSqliteQuerySync(
              db,
              database
                .selectFrom("agent_deletion_journal")
                .select(["agent_id", "agent_dir", "database_paths_json", "cleanup_completed"])
                .where((expression) =>
                  expression.or([
                    expression("cleanup_completed", "=", 0),
                    expression("delete_files", "=", 0),
                  ]),
                )
                .orderBy("agent_id", "asc"),
            ).rows.map((row) => {
              const databasePaths = parseDatabasePaths(row.database_paths_json);
              const entry: RetainedAgentDeletion = {
                agentId: row.agent_id,
                databasePaths: [
                  path.join(row.agent_dir, "openclaw-agent.sqlite"),
                  ...(databasePaths ?? []),
                ],
                state: row.cleanup_completed === 0 ? ("pending" as const) : ("retained" as const),
              };
              if (!databasePaths) {
                entry.warning = `Could not read database paths for deleted agent ${row.agent_id}; its known database identity remains held.`;
              }
              return entry;
            }),
          );
        },
        { env },
      ) ?? { status: "absent" as const }
    );
  } catch (error) {
    if (isSqliteCorruptionError(error)) {
      throw error;
    }
    return {
      status: "unavailable",
      warning: `Could not read retained agent deletion history: ${String(error)}`,
    };
  }
}
