import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { UpdatePreMutationError } from "./update-pre-mutation-error.js";

/** Refuse a downgrade that would strand an installed PostgreSQL store. */
export async function assertUpdateDatabaseEngineContexts(
  contexts: readonly { config: OpenClawConfig; env: NodeJS.ProcessEnv }[],
  targetEngines: unknown,
): Promise<void> {
  // A capable target cannot strand a PostgreSQL store. Avoid copying live databases
  // to rediscover their engines at every candidate inspection and activation boundary.
  if (Array.isArray(targetEngines) && targetEngines.includes("postgres")) {
    return;
  }
  const { discoverBackupDatabasePaths } = await import("./backup-sqlite-snapshot.js");
  const { readBackupEngine } = await import("../snapshot/database-backup.js");
  for (const context of contexts) {
    const paths = await discoverBackupDatabasePaths({
      ...context,
      stateDir: resolveStateDir(context.env),
    });
    const postgres = paths.find((pathname) => readBackupEngine(pathname).engine === "postgres");
    if (!postgres) {
      continue;
    }
    throw new UpdatePreMutationError(
      "database-engine-preflight",
      `Update refused: the target does not support the PostgreSQL store at ${postgres}. Reverse-port to SQLite with the current binary before updating, or stay on the current version. See https://docs.openclaw.ai/reference/database-engines.`,
    );
  }
}
