import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { ConfigSnapshotReadMeasure, ConfigSnapshotReadOptions } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { assertDatabasePortStartupAllowed } from "../infra/database-port-recovery.js";
import type { StartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { recordStartupMigrationWarnings } from "../infra/state-migrations.messages.js";
import { RetiredStateFormatError } from "../infra/state-migrations.retired-files.js";
import { assertNoRetiredRuntimeStateFiles } from "../infra/state-migrations.retired-runtime-files.js";
import type { PluginCache } from "../plugins/plugin-cache.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import {
  readAdmittedConfigSnapshot,
  createConfigPreflightSnapshotReader,
  type ConfigPreflightSnapshotRead,
} from "./config-preflight-snapshot.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import { refreshStartupPluginQuarantine } from "./doctor-config-preflight-plugin-verification.js";
import {
  rethrowStartupConfigFailure,
  throwStartupMigrationGuardRejected,
} from "./doctor-startup-migration-refusal.js";
import { cleanupStartupPluginSourceCaptures } from "./startup-plugin-source-captures.js";

// Persistent lease loss must reach the operator instead of retrying startup forever.
const STARTUP_LEASE_ATTEMPTS = 3;
export type StartupConfigPreflightOptions = {
  gateway: boolean;
  observe?: boolean;
  measure?: ConfigSnapshotReadMeasure;
  validateStartupConfig?: (snapshot: ConfigFileSnapshot) => void | Promise<void>;
  beforeStatePreparation?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
};

export type StartupConfigPreflightResult = ReturnType<typeof result> & {
  pluginCache?: PluginCache;
};

/** Prepare current runtime state; legacy imports and repair receipts belong to Doctor. */
export async function runStartupConfigPreflight(
  options: StartupConfigPreflightOptions,
): Promise<StartupConfigPreflightResult> {
  assertDatabasePortStartupAllowed(resolveStateDir(process.env));
  for (let attempt = 1; ; attempt++) {
    await using snapshots = createConfigPreflightSnapshotReader();
    const { withSqliteReadOnlyWorkerScope } = await import("../infra/sqlite-readonly-worker.js");
    try {
      const prepared = await withSqliteReadOnlyWorkerScope(() =>
        prepareStartupConfig(options, snapshots),
      );
      return {
        ...prepared,
        pluginCache: await snapshots.takePluginCache(prepared.pluginMetadataSnapshot),
      };
    } catch (error) {
      const { StartupMigrationLeaseLostError } =
        await import("../infra/startup-migration-checkpoint.js");
      if (error instanceof StartupMigrationLeaseLostError && attempt < STARTUP_LEASE_ATTEMPTS) {
        recordStartupMigrationWarnings(["Startup migration lease lost; reacquiring and retrying."]);
        continue;
      }
      if (options.gateway) {
        rethrowStartupConfigFailure(error);
      }
      throw error;
    }
  }
}

function readStartupStateWarnings(env: NodeJS.ProcessEnv): string[] {
  try {
    assertNoRetiredRuntimeStateFiles(resolveStateDir(env), env);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      error instanceof RetiredStateFormatError && error.cause === undefined
        ? `Retired runtime state was left unchanged for Doctor; no import was attempted. ${message}`
        : `Could not inspect retired runtime state: ${message}; run openclaw doctor`,
    ];
  }
}

async function prepareStartupConfig(
  options: StartupConfigPreflightOptions,
  snapshots: ReturnType<typeof createConfigPreflightSnapshotReader>,
): Promise<StartupConfigPreflightResult> {
  let env = process.env;
  const measure: ConfigSnapshotReadMeasure = options.measure ?? (async (_name, run) => await run());
  const readSnapshot = (readOptions?: Pick<ConfigSnapshotReadOptions, "isolateEnv">) =>
    snapshots.read({
      purpose: "startup",
      allowCurrentPluginMetadata: false,
      includePluginMetadata: true,
      isolateEnv: readOptions?.isolateEnv,
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
    recordStartupMigrationWarnings(readStartupStateWarnings(env));
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
    if (read.recovery) {
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
      const { withPluginLifecycleLease } = await import("../plugins/plugin-lifecycle-lease.js");
      await withPluginLifecycleLease(
        { env, assertCurrent: assertLeaseCurrent, processBound: true },
        async (pluginLease) => {
          // Recovery must consume the current config after both writers settle.
          read = await readAdmitted();
          if (!read.snapshot.valid) {
            return;
          }
          assertLeaseCurrent();
          if (read.recovery) {
            await read.recovery.apply(() => pluginLease.assertOwned());
            read = await readSnapshot();
          }
        },
      );
      if (!read.snapshot.valid) {
        return result(read);
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
          manifestRegistry: read.pluginMetadataSnapshot?.manifestRegistry,
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
      ...readStartupStateWarnings(env),
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

function result(read: ConfigPreflightSnapshotRead) {
  return {
    snapshot: read.snapshot,
    baseConfig: read.snapshot.sourceConfig,
    ...(read.pluginMetadataSnapshot ? { pluginMetadataSnapshot: read.pluginMetadataSnapshot } : {}),
  };
}
