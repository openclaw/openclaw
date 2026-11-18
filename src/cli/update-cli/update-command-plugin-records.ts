import {
  prepareDoctorConfigReferenceSource,
  restoreDoctorConfigEnvRefs,
} from "../../commands/doctor/shared/config-flow-steps.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  getDeferredPluginMigrationConfigFacts,
  setDeferredPluginMigrationConfigFacts,
} from "../../config/deferred-plugin-migration-config.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import type { DeferredPluginMigration } from "../../infra/deferred-plugin-migrations.js";
import { commitPluginInstallRecordsOnly } from "../../plugins/install-record-commit.js";

/**
 * Publishes plugin records alone when convergence changes no config path: the config write would
 * only restamp the file, so a config path the update cannot write cannot fail converged plugin
 * work. Returns false when the config does not read as valid, leaving that case to the write.
 */
export async function publishPluginRecordsWithoutConfigWrite(params: {
  previousInstallRecords: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  nextConfig: OpenClawConfig;
  /** The pending generation every other update read uses; without it such config reads invalid. */
  deferredPluginMigrations?: readonly DeferredPluginMigration[];
  assertCurrent: () => void;
  beforeCommit: () => Promise<void>;
}): Promise<boolean> {
  const readUnchanged = async () => {
    const snapshot = await readConfigFileSnapshot({
      observe: false,
      skipPluginValidation: true,
      suppressFutureVersionWarning: true,
      deferredPluginMigrations: params.deferredPluginMigrations,
    });
    params.assertCurrent();
    return snapshot.valid ? snapshot : undefined;
  };
  const snapshot = await readUnchanged();
  if (!snapshot) {
    return false;
  }
  const references = prepareDoctorConfigReferenceSource(snapshot);
  const source = structuredClone(snapshot.sourceConfig);
  const indexConfig = references ? restoreDoctorConfigEnvRefs(source, references) : source;
  setDeferredPluginMigrationConfigFacts(
    indexConfig,
    getDeferredPluginMigrationConfigFacts(params.nextConfig),
  );
  await commitPluginInstallRecordsOnly({
    beforePersistentEffect: params.beforeCommit,
    previousInstallRecords: params.previousInstallRecords,
    nextInstallRecords: params.nextInstallRecords,
    nextConfig: indexConfig,
    verifyConfigFresh: async () => {
      if (!(await readUnchanged())) {
        // Classified as a config conflict: the index write is restored and the phase defers.
        throw new ConfigMutationConflictError(
          "Config changed while plugin install records were being published.",
        );
      }
    },
  });
  return true;
}
