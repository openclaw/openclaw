import { readConfigFileSnapshot } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import {
  getDatabaseEngineSelection,
  installDatabaseEngineSelection,
  type DatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { assertDatabasePortStartupAllowed } from "../infra/database-port-recovery.js";
import { setGatewayCredentialEnvKeys } from "../infra/host-env-security.js";

/** Direct servers and embedded kernels enter before locks, state reads, or plugin config. */
export async function installGatewayDatabaseEngine(
  snapshot?: ConfigFileSnapshot,
  selection?: DatabaseEngineSelection,
): Promise<void> {
  assertDatabasePortStartupAllowed(resolveStateDir(process.env));
  let selected = selection ?? getDatabaseEngineSelection();
  if (selection) {
    installDatabaseEngineSelection(selection);
  }
  if (!selected) {
    const source =
      snapshot ??
      (await readConfigFileSnapshot({
        observe: false,
        isolateEnv: true,
        pluginValidation: "core-only",
      }));
    selected = await resolveDatabaseEngineSelection(source.config);
    installDatabaseEngineSelection(selected);
  }
  setGatewayCredentialEnvKeys(
    "database.postgres.connection",
    selected.postgres?.connectionEnvKey ? [selected.postgres.connectionEnvKey] : [],
  );
  if (Object.values(selected.effectiveEngines).includes("postgres")) {
    // Overlap service imports with subsequent Gateway config and plugin preparation.
    const { getPostgresPool } = await import("../infra/postgres-sync/pool.js");
    getPostgresPool();
  }
}
