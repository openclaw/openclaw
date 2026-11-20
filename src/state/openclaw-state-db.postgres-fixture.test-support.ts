import type pg from "pg";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";

export function installPostgresStateFixture(connection: string, schemaPrefix: string) {
  installDatabaseEngineSelection({
    effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
    postgres: { connection, schemaPrefix },
  });
}

export async function cleanupPostgresStateFixture(
  client: pg.Client,
  pathname: string,
  namespace: string | undefined,
) {
  retireSqliteDatabaseAdmissionForPath(pathname);
  resetDatabaseEngineSelectionForTest();
  try {
    if (namespace) {
      await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
    }
  } finally {
    await client.end();
  }
}

/** Fail only the marked row's first COMMIT; the sequence survives its rollback. */
export async function interruptNextPostgresStateCommit(
  client: pg.Client,
  namespace: string,
  writer: "shared-state" | "update-bookkeeping",
  runId: string,
) {
  const table = writer === "shared-state" ? "config_machine_state" : "update_runs";
  const interruptedRow =
    writer === "shared-state"
      ? `NEW.state_key = 'reconnect.fixture' AND NEW.value_json::jsonb = '"interrupted"'::jsonb`
      : `NEW.run_id = '${runId}' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(NEW.steps_json::jsonb) AS step
          WHERE step->>'step' = 'reconnect.fixture' AND step->>'detail' = 'interrupted'
        )`;
  // Fail inside dispatched COMMIT, not on a recoverable idle transport. The
  // nontransactional sequence makes the fault one-shot and exposes replay.
  await client.query(`
    CREATE SEQUENCE "${namespace}".reconnect_attempts;
    CREATE FUNCTION "${namespace}".interrupt_reconnect_commit() RETURNS trigger
    LANGUAGE plpgsql AS $fault$
    BEGIN
      IF ${interruptedRow} THEN
        IF nextval('"${namespace}".reconnect_attempts') = 1 THEN
          PERFORM pg_terminate_backend(pg_backend_pid());
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fault$;
    CREATE CONSTRAINT TRIGGER reconnect_commit_fault
      AFTER INSERT OR UPDATE ON "${namespace}"."${table}"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION "${namespace}".interrupt_reconnect_commit();
  `);
  return async () => {
    // Cold recovery validates the original catalog, without the injected trigger.
    await client.query(`
      DROP TRIGGER reconnect_commit_fault ON "${namespace}"."${table}";
      DROP FUNCTION "${namespace}".interrupt_reconnect_commit();
    `);
    return (
      await client.query(`SELECT last_value::int AS attempts, is_called
      FROM "${namespace}".reconnect_attempts`)
    ).rows;
  };
}
