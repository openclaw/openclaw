import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { UpdatePreMutationError } from "./update-pre-mutation-error.js";

/** The installed driver checks physical stores before candidate database mutation or publication. */
export async function assertUpdateDatabaseEngineContexts(
  contexts: readonly { config: OpenClawConfig; env: NodeJS.ProcessEnv }[],
  readTargetEngines: () => Promise<unknown>,
): Promise<void> {
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
    const engines = (await readTargetEngines()) ?? ["sqlite"];
    if (!Array.isArray(engines) || !engines.includes("postgres")) {
      throw new UpdatePreMutationError(
        "database-engine-preflight",
        `Update refused: the target does not support the PostgreSQL store at ${postgres}. Reverse-port to SQLite with the current binary before updating, or stay on the current version. See https://docs.openclaw.ai/reference/database-engines.`,
      );
    }
  }
}
