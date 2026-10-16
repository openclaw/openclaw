import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertHomogeneousDatabaseEngines,
  resolveDatabaseFamilyEngines,
} from "./database-engine/registry.js";
import { UpdatePreMutationError } from "./update-pre-mutation-error.js";

/** Refuse a downgrade that would strand an installed PostgreSQL store. */
export async function assertUpdateDatabaseEngineContexts(
  contexts: readonly { config: OpenClawConfig; env: NodeJS.ProcessEnv }[],
  targetEngines: unknown,
): Promise<void> {
  const supportsPostgres = Array.isArray(targetEngines) && targetEngines.includes("postgres");
  for (const { config } of contexts) {
    try {
      assertHomogeneousDatabaseEngines(config, "update");
      if (config.database?.families) {
        throw new Error(
          "Update with database.families overrides is not supported yet; use a matching database.engine default without family overrides, or wait for family-aware update support. Preserve the effective engines when changing configuration.",
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new UpdatePreMutationError("database-engine-preflight", error.message);
      }
      throw error;
    }
    if (
      !supportsPostgres &&
      Object.values(resolveDatabaseFamilyEngines(config)).includes("postgres")
    ) {
      throw new UpdatePreMutationError(
        "database-engine-preflight",
        "Update refused: the target does not support the configured PostgreSQL families. Reverse-port to SQLite with the current binary before updating, or stay on the current version. See https://docs.openclaw.ai/reference/database-engines.",
      );
    }
  }
  // A capable target cannot strand a PostgreSQL store. Avoid copying live databases
  // to rediscover their engines at every candidate inspection and activation boundary.
  if (supportsPostgres) {
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
