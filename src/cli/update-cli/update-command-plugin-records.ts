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
import type { PluginInstallBatchTarget } from "../../plugins/install-runtime-batch.js";
import { hashStableJson } from "../../plugins/installed-plugin-index-hash.js";

/** Project the records just published by the caller's continuously held lifecycle lease. */
export function collectPluginReloadTargets(
  previous: Record<string, PluginInstallRecord>,
  current: Record<string, PluginInstallRecord>,
): PluginInstallBatchTarget[] {
  const targets: PluginInstallBatchTarget[] = [];
  for (const [pluginId, record] of Object.entries(current)) {
    const installHash = hashStableJson(record);
    if (!previous[pluginId] || hashStableJson(previous[pluginId]) !== installHash) {
      targets.push({ pluginId, installHash });
    }
  }
  return targets;
}

/**
 * Hooks for publishing changed plugin records. The combined writer commits the install index
 * before the config writer's `beforeCommit`, so `beforeRecordWrite` guards that index write and
 * `beforeCommit` the config write and the records-only index write; each first runs the caller's
 * `beforeRecordPublication` (an update copies its originals there, once).
 */
export function createPluginRecordPublicationHooks(params: {
  beforeRecordPublication?: () => Promise<void>;
  configBeforeCommit?: () => void | Promise<void>;
  assertCurrent: () => void;
  assertRecoveryCurrent: () => Promise<void>;
}) {
  const beforeRecordWrite = async () => {
    await params.beforeRecordPublication?.();
    params.assertCurrent();
  };
  return {
    beforeRecordWrite,
    beforeCommit: async () => {
      await beforeRecordWrite();
      await params.configBeforeCommit?.();
      params.assertCurrent();
      await params.assertRecoveryCurrent();
      params.assertCurrent();
    },
  };
}

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
  /** The planned config target; a re-pointed link must not receive these records. */
  assertConfigPathForWrite?: () => void;
  assertCurrent: () => void;
  beforeCommit: () => Promise<void>;
}): Promise<boolean> {
  const readUnchanged = async () => {
    params.assertConfigPathForWrite?.();
    const snapshot = await readConfigFileSnapshot({
      observe: false,
      skipPluginValidation: true,
      suppressFutureVersionWarning: true,
      deferredPluginMigrations: params.deferredPluginMigrations,
    });
    params.assertConfigPathForWrite?.();
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
