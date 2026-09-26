import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { ConfigSnapshotReadMeasure, ConfigSnapshotReadOptions } from "../config/io.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { StartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { recordStartupMigrationWarnings } from "../infra/state-migrations.messages.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import {
  assertPreflightConfigUnchanged,
  needsRefreshedPluginIndexPersistence,
  persistRefreshedPluginIndex,
  readAdmittedConfigSnapshot,
  readConfigPreflightSnapshot,
  type ConfigPreflightSnapshotRead,
} from "./config-preflight-snapshot.js";
import { refreshStartupPluginQuarantine } from "./doctor-config-preflight-plugin-verification.js";
import { throwStartupMigrationGuardRejected } from "./doctor-startup-migration-refusal.js";

export type StartupConfigPreflightOptions = {
  gateway: boolean;
  observe?: boolean;
  measure?: ConfigSnapshotReadMeasure;
  validateStartupConfig?: (snapshot: ConfigFileSnapshot) => void | Promise<void>;
  beforeStatePreparation?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
};

export type StartupConfigPreflightResult = {
  snapshot: ConfigFileSnapshot;
  baseConfig: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

/** Prepare current runtime state; legacy imports and repair receipts belong to Doctor. */
export async function runStartupConfigPreflight(
  options: StartupConfigPreflightOptions,
): Promise<StartupConfigPreflightResult> {
  const { withSqliteReadOnlyWorkerScope } = await import("../infra/sqlite-readonly-worker.js");
  return await withSqliteReadOnlyWorkerScope(() => prepareStartupConfig(options));
}

async function prepareStartupConfig(
  options: StartupConfigPreflightOptions,
): Promise<StartupConfigPreflightResult> {
  let env = process.env;
  const measure: ConfigSnapshotReadMeasure = options.measure ?? (async (_name, run) => await run());
  const readSnapshot = (readOptions?: Pick<ConfigSnapshotReadOptions, "isolateEnv">) =>
    readConfigPreflightSnapshot({
      allowCurrentPluginMetadata: false,
      includePluginMetadata: true,
      isolateEnv: readOptions?.isolateEnv,
      preparePluginMetadataSnapshot: true,
      skipPluginValidation: false,
      observe: options.gateway ? false : options.observe,
      measure,
    });
  const beforeStatePreparation = async (snapshot?: ConfigFileSnapshot) => {
    if (options.beforeStatePreparation && !(await options.beforeStatePreparation(snapshot))) {
      throwStartupMigrationGuardRejected();
    }
  };
  if (!options.gateway) {
    const read = await readSnapshot();
    await beforeStatePreparation(read.snapshot);
    return result(read);
  }

  const readAdmitted = () =>
    readAdmittedConfigSnapshot({
      env,
      readSnapshot,
      validateConfig: options.validateStartupConfig,
      beforeStatePreparation: options.beforeStatePreparation,
    });
  let read = await readAdmitted();
  env = cloneEnvWithPlatformSemantics(process.env);
  if (!read.snapshot.valid) {
    return result(read);
  }
  let lease: StartupMigrationLease | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatError: Error | undefined;
  const assertLeaseCurrent = () => {
    if (heartbeatError) {
      throw heartbeatError;
    }
    lease?.heartbeat();
  };
  try {
    if (read.recovery || needsRefreshedPluginIndexPersistence(read)) {
      const { acquireStartupMigrationLeaseWithWait } =
        await import("../infra/startup-migration-checkpoint.js");
      lease = await acquireStartupMigrationLeaseWithWait({ env });
      heartbeat = setInterval(() => {
        try {
          lease?.heartbeat();
        } catch (error) {
          heartbeatError =
            error instanceof Error
              ? error
              : new Error("OpenClaw startup lease heartbeat failed.", { cause: error });
        }
      }, 60_000);
      heartbeat.unref();
      // Admission and recovery must name the generation observed after acquiring the writer lease.
      read = await readAdmitted();
      if (!read.snapshot.valid) {
        return result(read);
      }
      assertLeaseCurrent();
      if (read.recovery) {
        const recovered = read.snapshot;
        await read.recovery.apply(assertLeaseCurrent);
        read = await readSnapshot();
        assertPreflightConfigUnchanged(recovered, read.snapshot);
      }
      if (needsRefreshedPluginIndexPersistence(read)) {
        const persisted = await persistRefreshedPluginIndex({
          env,
          lease,
          measure,
          readPersistedSnapshot: readSnapshot,
          snapshotRead: read,
        });
        read = persisted.snapshotRead;
      }
    }
    const verification = await refreshStartupPluginQuarantine({
      cfg: read.snapshot.sourceConfig,
      env,
      measure,
    });
    setActiveDegradedPlugins(verification.quarantinedPlugins);
    recordStartupMigrationWarnings([
      ...(verification.warnings ?? []),
      ...(verification.deferredPlugins ?? []).map(
        (plugin) => `Plugin "${plugin.pluginId}": ${plugin.reason}. Run \`${plugin.command}\`.`,
      ),
    ]);
    await beforeStatePreparation(read.snapshot);
    assertLeaseCurrent();
    return result(read);
  } finally {
    clearInterval(heartbeat);
    lease?.release();
  }
}

function result(read: ConfigPreflightSnapshotRead): StartupConfigPreflightResult {
  return {
    snapshot: read.snapshot,
    baseConfig: read.snapshot.sourceConfig,
    ...(read.pluginMetadataSnapshot ? { pluginMetadataSnapshot: read.pluginMetadataSnapshot } : {}),
  };
}
