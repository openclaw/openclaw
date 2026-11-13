import { migrateDaemonRuntimePins } from "../../infra/state-migrations.daemon-runtime-pins.js";

/** Migrate fixture state under real storage custody before installing platform stubs. */
export async function seedCompletedRuntimePinMigration(env: NodeJS.ProcessEnv): Promise<void> {
  const result = await migrateDaemonRuntimePins(env);
  if (result.warnings.length) {
    throw new Error(result.warnings.join("\n"));
  }
}
