import path from "node:path";
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
  targetPostgresFamilies?: unknown,
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
  const { listDatabaseEngineStores, selectDatabaseEngine } =
    await import("./database-engine/registry.js");
  const { discoverBackupDatabasePaths } = await import("./backup-sqlite-snapshot.js");
  const { readBackupEngine, readPostgresBackupFamily } =
    await import("../snapshot/database-backup.js");
  const { readUpdateStateDatabaseInventory } = await import("./update-candidate-state.js");
  const { updateStateDatabaseExists } = await import("./update-candidate-state.sizes.js");
  for (const context of contexts) {
    const required = new Set(
      listDatabaseEngineStores()
        .filter((store) => selectDatabaseEngine(store, context.config) === "postgres")
        .map((store) => store.id),
    );
    // Preserve the SQLite path: a PostgreSQL-capable target needs no source copies.
    if (supportsPostgres && required.size === 0) {
      continue;
    }
    const stateDir = resolveStateDir(context.env);
    const paths = await discoverBackupDatabasePaths({
      ...context,
      stateDir,
      agentRegistry: [],
    });
    const postgres = paths.filter((pathname) => readBackupEngine(pathname).engine === "postgres");
    if (
      postgres.length === 0 &&
      (await updateStateDatabaseExists(path.join(stateDir, "state", "openclaw.sqlite")))
    ) {
      const inventory = await readUpdateStateDatabaseInventory({ ...context, stateDir });
      const known = new Set(paths);
      for (const file of [...inventory.values()].flatMap((entry) => entry.spellings)) {
        if (known.has(file) || !(await updateStateDatabaseExists(file))) {
          continue;
        }
        known.add(file);
        if (readBackupEngine(file).engine === "postgres") {
          postgres.push(file);
        }
      }
    }
    if (postgres.length === 0 && required.size === 0) {
      continue;
    }
    const refuse: (detail: string) => never = (detail) => {
      throw new UpdatePreMutationError(
        "database-engine-preflight",
        `Update refused: ${detail}. Reverse-port to SQLite with the current binary before updating, or stay on the current version. See https://docs.openclaw.ai/reference/database-engines.`,
      );
    };
    if (!supportsPostgres) {
      refuse(
        `the target does not support the PostgreSQL store at ${postgres[0] ?? "the configured PostgreSQL families"}`,
      );
    }
    const { requireDatabasePortProvider } = await import("./database-engine/port-provider.js");
    const admitFamily = (family: string) => {
      if (!Array.isArray(targetPostgresFamilies) || !targetPostgresFamilies.includes(family)) {
        refuse(`the target does not declare support for the PostgreSQL ${family} family`);
      }
      try {
        requireDatabasePortProvider(family);
      } catch (error) {
        refuse(error instanceof Error ? error.message : `No capture provider for ${family}`);
      }
    };
    for (const family of required) {
      admitFamily(family);
    }
    for (const pathname of postgres) {
      let family: string;
      try {
        family = await readPostgresBackupFamily(pathname, context.config);
      } catch {
        refuse(
          `PostgreSQL family at ${pathname} cannot be captured by this updater; use a version with a port and backup provider for that family`,
        );
      }
      admitFamily(family);
    }
  }
}
