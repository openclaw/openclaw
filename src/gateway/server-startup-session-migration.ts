<<<<<<< HEAD
import {
  runSessionStartupMigration,
  type SessionStartupMigrationLogger,
} from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type SessionMigrationDeps = Parameters<typeof runSessionStartupMigration>[0]["deps"];
=======
// Gateway startup session-store migration runner.
// Keeps old orphaned session keys from surviving process upgrades.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { migrateOrphanedSessionKeys } from "../infra/state-migrations.js";

type SessionMigrationLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

/**
 * Run orphan-key session migration at gateway startup.
 *
 * Idempotent and best-effort: if the migration fails, gateway startup
 * continues normally. This ensures accumulated orphaned session keys
 * (from the write-path bug #29683) are cleaned up automatically on
 * upgrade rather than requiring a manual `openclaw doctor` run.
 */
export async function runStartupSessionMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
<<<<<<< HEAD
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<void> {
  await runSessionStartupMigration(params);
=======
  log: SessionMigrationLogger;
  deps?: {
    migrateOrphanedSessionKeys?: typeof migrateOrphanedSessionKeys;
  };
}): Promise<void> {
  const migrate = params.deps?.migrateOrphanedSessionKeys ?? migrateOrphanedSessionKeys;
  try {
    const result = await migrate({
      cfg: params.cfg,
      env: params.env ?? process.env,
    });
    if (result.changes.length > 0) {
      params.log.info(
        `gateway: canonicalized orphaned session keys:\n${result.changes.map((c) => `- ${c}`).join("\n")}`,
      );
    }
    if (result.warnings.length > 0) {
      params.log.warn(
        `gateway: session key migration warnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}`,
      );
    }
  } catch (err) {
    params.log.warn(
      `gateway: orphaned session key migration failed during startup; continuing: ${String(err)}`,
    );
  }
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}
