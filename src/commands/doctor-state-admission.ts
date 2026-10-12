import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import {
  cloneEnvWithPlatformSemantics,
  createConfigRuntimeEnv,
} from "../config/config-env-vars.js";
import { createConfigIO } from "../config/io.factory.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSelectedCronJobsStorePath } from "../cron/store/paths.js";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import { listRetiredCronStateFiles } from "../infra/state-migrations.retired-cron-files.js";
import { listRetiredDeliveryQueueFiles } from "../infra/state-migrations.retired-delivery-files.js";
import { assertNoRetiredStateFiles } from "../infra/state-migrations.retired-files.js";
import { assertNoRetiredRuntimeStateFiles } from "../infra/state-migrations.retired-runtime-files.js";
import { resolveLegacyInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store-path.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { withOpenClawStateReadOnlyLocation } from "../state/openclaw-state-db-read-connection.js";
import {
  existingPathOrUndefined,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";
import {
  assertNoRetiredOAuthSidecarsBeforeConfigRecovery,
  listReferencedLegacyOAuthSidecarPaths,
} from "./doctor-auth-legacy-paths.js";
import { findRetiredConfigUpgradeRequirement } from "./doctor/shared/retired-config-formats.js";

/** Refuse unsupported sources before maintenance can advance any database schema. */
export async function assertDoctorStateMigrationSupported(env: NodeJS.ProcessEnv): Promise<void> {
  await withArtifactPreservingStateReads(async () => {
    const stateDir = resolveStateDir(env);
    assertNoRetiredRuntimeStateFiles(stateDir, env);
    assertNoRetiredOAuthSidecarsBeforeConfigRecovery({ env });
    const snapshot = await createConfigIO({
      env: cloneEnvWithPlatformSemantics(env),
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
    }).readConfigFileSnapshot();
    const cfg = snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig ?? snapshot.config;
    const retired = findRetiredConfigUpgradeRequirement(cfg);
    if (retired) {
      throw new Error(`${retired.message} ${retired.nextAction}`);
    }
    assertNoRetiredStateFiles("JSON delivery queues", listRetiredDeliveryQueueFiles(stateDir));
    assertNoRetiredStateFiles("Plugin install index", [
      resolveLegacyInstalledPluginIndexStorePath({ stateDir }),
    ]);
    const { detectLegacySandboxRegistryFileIssues } = await import("./doctor-sandbox.js");
    assertNoRetiredStateFiles(
      "Sandbox registries",
      (await detectLegacySandboxRegistryFileIssues(stateDir)).map((file) => file.path),
    );
    assertNoRetiredStateFiles("OAuth credential sidecars", [
      ...listReferencedLegacyOAuthSidecarPaths(env, cfg),
      ...listReferencedLegacyOAuthSidecarPaths(createConfigRuntimeEnv(cfg, env), cfg),
    ]);
    let cronStore = readNonBlankString(asOptionalRecord(cfg.cron)?.store);
    if (!cronStore) {
      const statePath = existingPathOrUndefined(resolveOpenClawStateSqlitePath(env));
      if (statePath) {
        // Inspect private bytes even when runtime reads are quarantined for Doctor repair.
        assertStateDatabaseAccessAllowed(statePath);
        cronStore = withOpenClawStateReadOnlyLocation(
          ({ db }) => {
            const row = readConfigMachineStateRowInDatabase(db, "cron.store");
            return row ? readNonBlankString(JSON.parse(row.value_json)) : undefined;
          },
          statePath,
          prepareSqliteReadOnlyLocationSync(statePath),
          openDoctorStateSchemaReadAdmission,
        );
      }
    }
    assertNoRetiredStateFiles(
      "Cron state",
      await listRetiredCronStateFiles(resolveSelectedCronJobsStorePath(cronStore, env)),
    );
  });
}
