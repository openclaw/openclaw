import {
  cloneEnvWithPlatformSemantics,
  createConfigRuntimeEnv,
} from "../config/config-env-vars.js";
import { createConfigIO } from "../config/io.factory.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store/paths.js";
import { listRetiredCronStateFiles } from "../infra/state-migrations.retired-cron-files.js";
import { listRetiredDeliveryQueueFiles } from "../infra/state-migrations.retired-delivery-files.js";
import { assertNoRetiredStateFiles } from "../infra/state-migrations.retired-files.js";
import { assertNoRetiredRuntimeStateFiles } from "../infra/state-migrations.retired-runtime-files.js";
import { resolveLegacyInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store-path.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
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
    assertNoRetiredStateFiles(
      "Cron state",
      await listRetiredCronStateFiles(resolveCronJobsStorePathFromConfig(cfg, env)),
    );
  });
}
