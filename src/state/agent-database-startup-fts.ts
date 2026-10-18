import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { backupDoctorSqliteRepair } from "../infra/sqlite-index-recovery.js";
import {
  classifySqliteFtsIntegrityFindings,
  repairSqliteIndexCorruption,
} from "../infra/sqlite-index-schema.js";
import { readSqliteIntegrityFindings } from "../infra/sqlite-integrity.js";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { mayShareAgentDatabaseFile } from "./openclaw-agent-db-lease-provenance.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "./openclaw-agent-db-lease.js";
import { OPENCLAW_AGENT_FTS_SCHEMAS } from "./openclaw-agent-fts-schema.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";

type StartupRepair = (database: DatabaseSync) => boolean;
const startupRepair = new AsyncLocalStorage<StartupRepair>();

export function withAgentDatabaseStartupFtsRepair<T>(
  enabled: boolean,
  input: {
    agentId: string;
    databasePath: string;
    leaseId: string;
    environment: NodeJS.ProcessEnv;
  },
  assertCurrent: () => void,
  run: () => T,
): T {
  if (!enabled) {
    return run();
  }
  return startupRepair.run(
    (database) =>
      repairAgentDatabaseStartupFts(database, input.databasePath, input.agentId, {
        leaseId: input.leaseId,
        env: input.environment,
        assertCurrent,
        begin: () =>
          requestSqliteWorkerOperationAdmission({
            stage: "prepare",
            facts: { kind: "agent-startup-fts-begin" },
          }),
        report: (message, repaired) =>
          requestSqliteWorkerOperationAdmission({
            stage: "prepare",
            facts: { kind: "agent-startup-fts-result", message, repaired },
          }),
      }),
    run,
  );
}

export function tryAgentDatabaseStartupFtsRepair(database: DatabaseSync): boolean {
  return startupRepair.getStore()?.(database) ?? false;
}

/** Startup borrows Doctor's backed-up transaction only while its runtime lease is exclusive. */
function repairAgentDatabaseStartupFts(
  database: DatabaseSync,
  pathname: string,
  agentId: string,
  admission: {
    begin: () => void;
    assertCurrent: () => void;
    report: (message: string, repaired: boolean) => void;
    leaseId: string;
    env: NodeJS.ProcessEnv;
  },
): boolean {
  const tables = classifySqliteFtsIntegrityFindings(
    database,
    readSqliteIntegrityFindings(database),
    OPENCLAW_AGENT_FTS_SCHEMAS,
  );
  if (!tables) {
    return false;
  }
  admission.begin();
  let backup: string | undefined;
  try {
    const message = runOpenClawStateWriteTransaction(
      () => {
        admission.assertCurrent();
        const owners = readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: admission.env });
        if (
          !owners.some(
            (owner) => owner.lease_id === admission.leaseId && owner.path === pathname,
          ) ||
          owners.some(
            (owner) =>
              owner.lease_id !== admission.leaseId &&
              mayShareAgentDatabaseFile(owner.path, pathname),
          )
        ) {
          throw new Error("Startup FTS repair requires an exclusive live agent database lease");
        }
        const counts = tables.map((table) => {
          const row = database
            .prepare(`SELECT count(*) AS n FROM main.${quoteSqliteIdentifier(table)}`)
            .get();
          return `${table}=${String(row?.n)}`;
        });
        repairSqliteIndexCorruption(database, pathname, {
          ftsSchemas: OPENCLAW_AGENT_FTS_SCHEMAS,
          ftsOnly: true,
          assertCurrent: admission.assertCurrent,
          backup: () => {
            admission.assertCurrent();
            backup = backupDoctorSqliteRepair(pathname, "index");
            admission.assertCurrent();
          },
        });
        const version = database.prepare("SELECT sqlite_version() AS version").get()?.version;
        return `Rebuilt stale agent SQLite FTS indexes for ${agentId}: ${counts.join(", ")}; SQLite ${String(version)}; preserved rows; backup: ${backup}.`;
      },
      { env: admission.env, initializationAgentPaths: [pathname] },
    );
    admission.report(message, true);
    return true;
  } catch (error) {
    admission.report(
      `Startup FTS repair failed for agent ${agentId} (${pathname}): ${String(error)}.${backup ? ` Backup: ${backup}.` : ""} Run openclaw doctor --fix.`,
      false,
    );
    throw error;
  }
}
