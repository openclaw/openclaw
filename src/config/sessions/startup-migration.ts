import { migrateOrphanedSessionKeys } from "../../infra/state-migrations.js";
import type { OpenClawConfig } from "../types.openclaw.js";

export type SessionStartupMigrationLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/**
 * Run orphan-key session migration before runtime session store reads.
 *
 * The migration is idempotent and best-effort: startup continues if the repair
 * fails, but warnings stay visible so exact-key runtime access does not hide
 * legacy store states that still need operator attention.
 */
export async function runSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
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
        `session: canonicalized orphaned session keys:\n${result.changes.map((c) => `- ${c}`).join("\n")}`,
      );
    }
    if (result.warnings.length > 0) {
      params.log.warn(
        `session: session key migration warnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}`,
      );
    }
  } catch (err) {
    params.log.warn(
      `session: orphaned session key migration failed during startup; continuing: ${String(err)}`,
    );
  }
}
