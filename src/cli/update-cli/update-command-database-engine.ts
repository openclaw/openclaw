import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { createUpdateConfigFailure } from "./update-command-config-failure.js";

/** Read authored update configuration without selecting or opening a database. */
export async function readUpdateDatabaseEngineConfig(env: NodeJS.ProcessEnv) {
  const [
    { cloneEnvWithPlatformSemantics },
    { createConfigIO },
    { isConfigReadFailure },
    { loadDotEnvAsync },
  ] = await Promise.all([
    import("../../config/env-vars.js"),
    import("../../config/io.js"),
    import("../../config/io.invalid-config.js"),
    import("../../infra/dotenv.js"),
  ]);
  const configEnv = cloneEnvWithPlatformSemantics(env);
  await loadDotEnvAsync({ env: configEnv });
  const snapshot = await createConfigIO({
    env: configEnv,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  return {
    configEnv,
    snapshot,
    readFailed: isConfigReadFailure(snapshot),
    sourceInvalid: snapshot.issues.some((issue) => issue.errorCode === "CONFIG_SOURCE_INVALID"),
  };
}

export async function withUpdateDatabaseEngine<T>(
  env: NodeJS.ProcessEnv,
  run: (configReadable: boolean, malformedConfig?: ConfigFileSnapshot) => Promise<T>,
  opts?: { dryRun?: boolean },
): Promise<T> {
  const { configEnv, snapshot, readFailed, sourceInvalid } =
    await readUpdateDatabaseEngineConfig(env);
  if (readFailed || sourceInvalid) {
    // Preview preflight reports the refusal without inferring an engine from unreadable config.
    if (opts?.dryRun) {
      return await run(false, readFailed ? undefined : snapshot);
    }
    throw createUpdateConfigFailure(snapshot);
  }
  // Candidate Doctor owns config recovery; admission only needs the authored engine choice.
  const [{ resolveDatabaseEngineSelection }, { withDatabaseEngineSelection }] = await Promise.all([
    import("../../infra/database-engine/config.js"),
    import("../../infra/database-engine/context.js"),
  ]);
  const selection = await resolveDatabaseEngineSelection(snapshot.sourceConfig, configEnv);
  return await withDatabaseEngineSelection(selection, async () => {
    const { preparePostgresPoolForUpdate } = await import("../../infra/postgres-sync/pool.js");
    await preparePostgresPoolForUpdate("openclaw update repair");
    return await run(true);
  });
}
