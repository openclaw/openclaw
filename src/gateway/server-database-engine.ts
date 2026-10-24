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

/** Direct servers and embedded kernels enter before locks, state reads, or plugin config. */
export async function installGatewayDatabaseEngine(
  snapshot?: ConfigFileSnapshot,
  selection?: DatabaseEngineSelection,
): Promise<void> {
  assertDatabasePortStartupAllowed(resolveStateDir(process.env));
  if (selection) {
    installDatabaseEngineSelection(selection);
    return;
  }
  if (getDatabaseEngineSelection()) {
    return;
  }
  const selected =
    snapshot ??
    (await readConfigFileSnapshot({
      observe: false,
      isolateEnv: true,
      pluginValidation: "core-only",
    }));
  installDatabaseEngineSelection(await resolveDatabaseEngineSelection(selected.config));
}
