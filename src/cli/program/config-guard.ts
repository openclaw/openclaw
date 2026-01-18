import {
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../../config/config.js";
import { danger } from "../../globals.js";
import { autoMigrateLegacyState } from "../../infra/state-migrations.js";
import type { RuntimeEnv } from "../../runtime.js";

export async function ensureConfigReady(params: {
  runtime: RuntimeEnv;
  migrateState?: boolean;
}): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.legacyIssues.length > 0) {
    if (isNixMode) {
      params.runtime.error(
        danger(
          "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and retry.",
        ),
      );
      params.runtime.exit(1);
      return;
    }
    const migrated = migrateLegacyConfig(snapshot.parsed);
    if (migrated.config) {
      await writeConfigFile(migrated.config);
      if (migrated.changes.length > 0) {
        params.runtime.log(
          `Migrated legacy config entries:\n${migrated.changes
            .map((entry) => `- ${entry}`)
            .join("\n")}`,
        );
      }
    } else {
      const issues = snapshot.legacyIssues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join("\n");
      params.runtime.error(
        danger(
          `Legacy config entries detected. Run "clawdbot doctor" (or ask your agent) to migrate.\n${issues}`,
        ),
      );
      params.runtime.exit(1);
      return;
    }
  }

  if (snapshot.exists && !snapshot.valid) {
    params.runtime.error(`Config invalid at ${snapshot.path}.`);
    for (const issue of snapshot.issues) {
      params.runtime.error(`- ${issue.path || "<root>"}: ${issue.message}`);
    }
    params.runtime.error("Run `clawdbot doctor` to repair, then retry.");
    params.runtime.exit(1);
    return;
  }

  if (params.migrateState !== false) {
    const cfg = loadConfig();
    await autoMigrateLegacyState({ cfg });
  }
}
