import { readFileSync } from "node:fs";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { closePostgresPool } from "../postgres-sync/pool.js";
import { createUpdateRun } from "../update-run-ledger.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const { connection, prefix, pathname }: { connection: string; prefix: string; pathname: string } =
  JSON.parse(readFileSync(0, "utf8"));
installDatabaseEngineSelection({
  effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
  postgres: { connection, schemaPrefix: prefix },
});
try {
  withEngineStoreAdmission(() => {
    createUpdateRun({ trigger: "cli", preview: true }, { path: pathname });
  });
} finally {
  closeOpenClawStateDatabaseForTest();
  await closePostgresPool();
}
