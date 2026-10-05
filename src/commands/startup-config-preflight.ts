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
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import { refreshStartupPluginQuarantine } from "./doctor-config-preflight-plugin-verification.js";
import {
  rethrowStartupConfigFailure,
  throwStartupMigrationGuardRejected,
} from "./doctor-startup-migration-refusal.js";
import { cleanupStartupPluginSourceCaptures } from "./startup-plugin-source-captures.js";

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
  try {
    return await withSqliteReadOnlyWorkerScope(() => prepareStartupConfig(options));
  } catch (error) {
    if (options.gateway) {
      rethrowStartupConfigFailure(error);
    }
    throw error;
  }
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
    return true;
  };
  if (!options.gateway) {
    const read = await readSnapshot();
    await beforeStatePreparation(read.snapshot);
    if (read.snapshot.valid && options.observe !== false) {
      await cleanupStartupPluginSourceCaptures(env);
    }
    return result(read);
  }

  const readAdmitted = () =>
    readAdmittedConfigSnapshot({
      env,
      readSnapshot,
      validateConfig: options.validateStartupConfig,
      beforeStatePreparation,
    });
  let read = await readAdmitted();
  env = cloneEnvWithPlatformSemantics(process.env);
  if (!read.snapshot.valid) {
    return result(read);
  }
  let lease: StartupMigrationLease | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatError: Error | undefined;
  const assertHeartbeatCurrent = () => {
    if (heartbeatError) {
      throw heartbeatError;
    }
  };
  const assertLeaseCurrent = () => {
    assertHeartbeatCurrent();
    lease?.assertOwned();
  };
  try {
    if (read.recovery || needsRefreshedPluginIndexPersistence(read)) {
      const { acquireStartupMigrationLeaseWithWait } =
        await import("../infra/startup-migration-checkpoint.js");
      lease = await measureDoctorConfigPreflightStep("migration-lease", () =>
        acquireStartupMigrationLeaseWithWait({ env }),
      );
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
        const persisted = await measureDoctorConfigPreflightStep("plugin-index.refresh", () =>
          persistRefreshedPluginIndex({
            env,
            lease,
            measure,
            readPersistedSnapshot: readSnapshot,
            snapshotRead: read,
            assertCurrent: assertHeartbeatCurrent,
          }),
        );
        read = persisted.snapshotRead;
      }
    }
    const { HISTORICAL_WEBHOOK_CHANNELS, recordUnwrittenWebhookCompletion } =
      await import("./doctor/shared/legacy-webhook-pins.js");
    const webhookCompletion = read.snapshot.sourceConfig.meta?.migrations?.webhookListeners;
    if (
      webhookCompletion !== true &&
      !HISTORICAL_WEBHOOK_CHANNELS.every((id) => Object.hasOwn(webhookCompletion ?? {}, id))
    ) {
      const migration = await measureDoctorConfigPreflightStep("webhook-readiness", async () => {
        const { applyPluginDoctorCompatibilityMigrations } =
          await import("../plugins/doctor-contract-registry.js");
        return applyPluginDoctorCompatibilityMigrations(read.snapshot.sourceConfig, {
          config: read.snapshot.sourceConfig,
          env,
          pluginIds: HISTORICAL_WEBHOOK_CHANNELS,
          historicalWebhookListeners: true,
          startup: true,
        });
      });
      if (migration.warnings?.length) {
        throw new Error(migration.warnings.join("\n"));
      }
      if (migration.changes.length) {
        await beforeStatePreparation(read.snapshot);
        assertPreflightConfigUnchanged(read.snapshot, (await readSnapshot()).snapshot);
        assertLeaseCurrent();
        if (!recordUnwrittenWebhookCompletion(read.snapshot, migration, env)) {
          const { StartupMaintenanceRequiredError } =
            await import("../infra/startup-maintenance-required.js");
          throw new StartupMaintenanceRequiredError(
            "state-migrations",
            `Webhook listeners require config migration. Run \`openclaw doctor --fix\`, then restart. Startup left the config unchanged.\n${migration.changes.join("\n")}`,
          );
        }
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
    const acquiredLease = lease;
    if (acquiredLease) {
      await measureDoctorConfigPreflightStep("migration-lease-release", () =>
        acquiredLease.release(),
      );
    }
  }
}

function result(read: ConfigPreflightSnapshotRead): StartupConfigPreflightResult {
  return {
    snapshot: read.snapshot,
    baseConfig: read.snapshot.sourceConfig,
    ...(read.pluginMetadataSnapshot ? { pluginMetadataSnapshot: read.pluginMetadataSnapshot } : {}),
  };
}
