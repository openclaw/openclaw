import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isSessionStoreTopologyChange, sessionChanges } from "../sessions/session-row-changes.js";
import { hasClawDeletionOwnership } from "./agent-deletion-journal-authority.worker.js";
import { hasPreJournalStateSchema } from "./agent-deletion-journal-history.js";
import { readAgentDeletionRecoveryHolds } from "./agent-deletion-journal-recovery.kernel.js";
import type {
  AgentDatabaseDeletionSnapshot,
  AgentDatabaseDeletionWorkerSnapshot,
  AgentDeletionJournalDisposition,
  AgentDeletionJournalPurpose,
  AgentDeletionJournalStatus,
  RetainedAgentDeletion,
} from "./agent-deletion-journal.types.js";
import {
  isOpenClawAgentDatabaseRegistryChange,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
} from "./openclaw-agent-db-registry-listing.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { resolveDatabasePath, resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { prepareOpenClawStateReadSource } from "./openclaw-state-worker-context.js";

export async function readAgentDeletionRecoveryHoldsInWorker(
  options: OpenClawStateDatabaseOptions = {},
) {
  const statePath = resolveDatabasePath(options);
  const reply = await executeExistingOpenClawStateRead(
    { ...options, path: statePath },
    { type: "agentRecovery.holds", input: { statePath } },
    { current: true },
  );
  if (reply && (!reply.ok || reply.type !== "agentRecovery.holds")) {
    throw new Error("Unexpected agent recovery holds result");
  }
  return reply?.held ?? [];
}

export async function readAgentDeletionJournalForCreation(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "agentRecovery.creationJournal", input: { agentId: normalizeAgentId(agentId) } },
    { current: true },
  );
  if (reply && (!reply.ok || reply.type !== "agentRecovery.creationJournal")) {
    throw new Error("Unexpected agent creation journal result");
  }
  return reply?.journal;
}

/** Completed cleanup still retains a deletion tombstone. */
export function readAgentDeletionJournalStatusInDatabase(
  database: DatabaseSync,
  agentId: string,
): AgentDeletionJournalStatus {
  if (!tableExists(database, "agent_deletion_journal")) {
    return "absent";
  }
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database)
      .selectFrom("agent_deletion_journal")
      .select("cleanup_completed")
      .where("agent_id", "=", normalizeAgentId(agentId)),
  );
  return row ? (row.cleanup_completed === 1 ? "complete" : "pending") : "absent";
}

export async function readAgentDeletionJournalStatusInWorker(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
  signal?: AbortSignal,
): Promise<AgentDeletionJournalStatus> {
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "agentDeletionJournal.status", agentId: normalizeAgentId(agentId) },
    { current: true, signal },
  );
  if (reply && (!reply.ok || reply.type !== "agentDeletionJournal.status")) {
    throw new Error("Unexpected agent deletion journal read result");
  }
  return reply?.status ?? "absent";
}

export function parseAgentDeletionDatabasePaths(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    Array.isArray(parsed) &&
    parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    return parsed;
  }
  throw new Error("Invalid agent deletion database path journal.");
}

/** Read existing deletion history without initializing or repairing the journal. */
export function readRetainedAgentDeletionsFromDatabase(
  database: DatabaseSync,
  statePath: string,
  purpose: AgentDeletionJournalPurpose = "maintenance",
): AgentDeletionJournalDisposition {
  let entries: RetainedAgentDeletion[] = [];
  let missing = false;
  let unreadableReason: string | undefined;
  try {
    missing = !tableExists(database, "agent_deletion_journal");
    if (!missing) {
      entries = executeSqliteQuerySync(
        database,
        getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database)
          .selectFrom("agent_deletion_journal")
          .selectAll()
          .where((eb) => {
            const retained = eb.and([eb("cleanup_completed", "=", 1), eb("delete_files", "=", 0)]);
            // Pending stores belong to deletion recovery, not offline migration.
            return purpose === "maintenance"
              ? eb.or([retained, eb("cleanup_completed", "=", 0)])
              : retained;
          })
          .orderBy("agent_id", "asc"),
      ).rows.map((row) => {
        let databasePaths: string[] = [];
        try {
          databasePaths = parseAgentDeletionDatabasePaths(row.database_paths_json);
        } catch (error) {
          if (purpose === "maintenance") {
            unreadableReason ??= formatErrorMessage(error);
          }
          // Unreadable path details cannot erase this row's known deleted identity.
        }
        const entry: RetainedAgentDeletion = {
          agentId: row.agent_id,
          agentDir: row.agent_dir,
          databasePaths: [path.join(row.agent_dir, "openclaw-agent.sqlite"), ...databasePaths],
          cleanupCompleted: row.cleanup_completed === 1,
        };
        if (
          row.cleanup_completed === 0 &&
          row.phase == null &&
          hasClawDeletionOwnership({ db: database }, row.agent_id)
        ) {
          entry.manualClawRemoval = true;
        }
        return entry;
      });
    }
  } catch (error) {
    if (isSqliteCorruptionError(error)) {
      throw error;
    }
    unreadableReason = formatErrorMessage(error);
  }
  const held =
    purpose === "maintenance" && tableExists(database, "migration_sources")
      ? readAgentDeletionRecoveryHolds({ db: database, path: statePath })
      : [];
  if (missing && held.length === 0 && hasPreJournalStateSchema(database)) {
    return { status: "empty" };
  }
  if (missing || unreadableReason !== undefined) {
    return {
      status: "unavailable",
      cause: missing ? "missing" : "unreadable",
      reason: missing
        ? "deletion journal missing"
        : `deletion journal unreadable: ${unreadableReason}`,
      ...(entries.length || held.length ? { known: { entries, held } } : {}),
    };
  }
  return entries.length || held.length ? { status: "present", entries, held } : { status: "empty" };
}

/** Read journal and registered-owner facts from one shared-state generation. */
export function readAgentDatabaseDeletionSnapshot(
  env: NodeJS.ProcessEnv,
  purpose: AgentDeletionJournalPurpose = "maintenance",
): AgentDatabaseDeletionSnapshot | undefined {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db, path: statePath }) =>
      runSqliteDeferredTransactionSync(
        db,
        () => ({
          retainedDeletions: readRetainedAgentDeletionsFromDatabase(db, statePath, purpose),
          registeredAgentDatabases: readRegisteredAgentDatabaseRows(db, statePath, false),
        }),
        { operationLabel: "agentDeletionJournal.snapshot" },
      ),
    { env },
  );
}

type PreparedAgentDatabaseDeletionSnapshot = {
  snapshot: AgentDatabaseDeletionWorkerSnapshot | undefined;
  assertCurrent: () => void;
};

/** Repeated discovery reads keep their original source custody and observe current committed facts. */
export function prepareAgentDatabaseDeletionSnapshotRead(
  inputOptions: OpenClawStateDatabaseOptions = {},
  purpose: AgentDeletionJournalPurpose = "maintenance",
): {
  read(): Promise<PreparedAgentDatabaseDeletionSnapshot>;
  readWithCurrentAdmission(): Promise<PreparedAgentDatabaseDeletionSnapshot>;
  withCurrentSnapshot<T>(
    consume: (
      snapshot: AgentDatabaseDeletionWorkerSnapshot | undefined,
      assertCurrent: () => void,
    ) => T | Promise<T>,
  ): Promise<T>;
} {
  const env = cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = {
    env,
    path: path.resolve(inputOptions.path ?? resolveOpenClawStateSqlitePath(env)),
  };
  const source = prepareOpenClawStateReadSource(options);
  const context = source.workerContext();
  const readSnapshot = async (readContext: typeof context) => {
    const assertReadCurrent = () => {
      readContext.maintenanceScope?.assertAdmission();
      readContext.admission.assertCurrent();
    };
    assertReadCurrent();
    const reply = await executeExistingOpenClawStateRead(
      options,
      { type: "agentDatabaseDeletion.snapshot", purpose },
      { context: readContext, current: true },
    );
    assertReadCurrent();
    if (reply && (!reply.ok || reply.type !== "agentDatabaseDeletion.snapshot")) {
      throw new Error("Unexpected agent database deletion snapshot result");
    }
    return { snapshot: reply?.snapshot, assertCurrent: assertReadCurrent };
  };
  const read = () => readSnapshot(context);
  return {
    read,
    async readWithCurrentAdmission() {
      return source.withCurrent(readSnapshot);
    },
    async withCurrentSnapshot(consume) {
      let changed: boolean;
      let assertRegistryCurrent: (() => void) | undefined;
      const stop = sessionChanges.subscribeFacts((change) => {
        if (
          isSessionStoreTopologyChange(change) &&
          (!assertRegistryCurrent || !isOpenClawAgentDatabaseRegistryChange(change))
        ) {
          changed = true;
        }
      });
      try {
        for (;;) {
          changed = false;
          const { snapshot, assertCurrent } = await read();
          assertCurrent();
          if (changed) {
            continue;
          }
          // Writer promotion can renew an existing registration without changing discovery facts.
          const registry = prepareOpenClawAgentDatabaseRegistrySnapshotRead(
            options,
            (mutation) =>
              mutation.kind === "upsert" &&
              mutation.sources.every((registration) =>
                snapshot?.registeredAgentDatabases.some(
                  (entry) =>
                    entry.agentId === registration.agentId &&
                    entry.path === registration.path &&
                    entry.schemaVersion === registration.schemaVersion,
                ),
              ),
          );
          assertRegistryCurrent = registry.assertCurrent;
          // Host commits publish before worker replies; consume before yielding again.
          // Once invoked, the operation is never replayed, including its later failures.
          return await consume(snapshot, () => {
            assertCurrent();
            if (changed) {
              throw new Error("Agent database deletion snapshot changed during consumption.");
            }
            assertRegistryCurrent?.();
          });
        }
      } finally {
        changed = true;
        stop();
      }
    },
  };
}
