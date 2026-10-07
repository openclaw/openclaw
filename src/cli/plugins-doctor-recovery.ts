/** Explicit offline actions remain with the selected trusted plugin Doctor owner. */
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { runPostSessionPluginDoctorStateRepairs } from "../infra/state-migrations.plugin-doctor.js";
import { resolveLivePluginDoctorStateMigrationInventory } from "../plugins/doctor-contract-registry.js";
import { loadBundledPluginManifestRegistry } from "../plugins/manifest-registry-build.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import { defaultRuntime } from "../runtime.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { exitCliAfterOutput } from "./one-shot-exit.js";
import type { PluginDoctorOptions } from "./plugins-cli.js";

async function runPluginDoctorRecovery(opts: PluginDoctorOptions, env = process.env) {
  if (
    !opts.plugin?.trim() ||
    !opts.migration?.trim() ||
    !opts.recovery?.trim() ||
    !opts.ids?.length ||
    !opts.reason?.trim() ||
    opts.confirmRetiredWithoutDelivery !== true ||
    !["installed", "bundled"].includes(opts.source ?? "installed")
  ) {
    throw new Error(
      "Offline recovery requires exact --plugin, --migration, --recovery, --ids, --reason and --confirm-retired-without-delivery; --source is installed or bundled",
    );
  }
  return await withDoctorSqliteMaintenanceLock({
    env,
    operation: "explicit plugin Doctor recovery",
    run: async (maintenance) => {
      const prepared = await withAgentDatabaseMaintenanceLease(
        { env, schemaPolicy: "existing", processBound: true },
        async () =>
          withPluginLifecycleLease(
            { env, schemaPolicy: "existing", assertCurrent: () => maintenance.assertCurrent() },
            async (lease) => {
              const snapshot = await readConfigFileSnapshot();
              maintenance.assertCurrent();
              lease.assertOwned();
              if (!snapshot.valid) {
                throw new Error("Repair invalid configuration before plugin recovery");
              }
              const config = snapshot.runtimeConfig;
              const registry =
                opts.source === "bundled"
                  ? loadBundledPluginManifestRegistry({
                      env: { ...env, OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1" },
                    })
                  : loadPluginManifestRegistryForPluginRegistry({
                      config,
                      env,
                      includeDisabled: true,
                    });
              const records = registry.plugins.filter((record) => record.id === opts.plugin);
              const record = records[0];
              if (
                records.length !== 1 ||
                !record ||
                (record.origin !== "bundled" && record.trustedOfficialInstall !== true)
              ) {
                throw new Error(
                  "Offline recovery requires exactly one trusted installed or packaged bundled plugin owner",
                );
              }
              const selectedInventory = resolveLivePluginDoctorStateMigrationInventory({
                config,
                env,
                manifestRegistry: { ...registry, plugins: records },
                pluginIds: [record.id],
              });
              if (selectedInventory.resolutionFailure || selectedInventory.records?.length !== 1) {
                throw new Error(
                  "Selected owner is unavailable under native migration activation policy",
                );
              }
              const inventory = { ...selectedInventory, knownPluginIds: [record.id] };
              const result = await runPostSessionPluginDoctorStateRepairs({
                config,
                env,
                maintenanceAuthority: maintenance,
                inventory,
                recovery: {
                  pluginId: record.id,
                  migrationId: opts.migration!,
                  request: { action: opts.recovery!, ids: opts.ids!, reason: opts.reason! },
                  deferRepair: true,
                },
              });
              maintenance.assertCurrent();
              lease.assertOwned();
              return { result, config, inventory };
            },
          ),
      );
      maintenance.assertCurrent();
      if (prepared.result.warnings.length) {
        return { ...prepared.result, stateDir: resolveStateDir(env) };
      }
      // Existing-schema receipt custody cannot admit SQLite worker writes. Keep
      // offline ownership while ordinary repair acquires its own native leases.
      const repaired = await runPostSessionPluginDoctorStateRepairs({
        config: prepared.config,
        env,
        maintenanceAuthority: maintenance,
        inventory: prepared.inventory,
      });
      maintenance.assertCurrent();
      return {
        ...repaired,
        changes: [...prepared.result.changes, ...repaired.changes],
        ...(prepared.result.notices?.length || repaired.notices?.length
          ? { notices: [...(prepared.result.notices ?? []), ...(repaired.notices ?? [])] }
          : {}),
        stateDir: resolveStateDir(env),
      };
    },
  });
}

export async function runPluginsDoctorCommand(opts: PluginDoctorOptions = {}): Promise<void> {
  if (
    opts.source ||
    opts.recovery ||
    opts.plugin ||
    opts.migration ||
    opts.ids ||
    opts.reason ||
    opts.confirmRetiredWithoutDelivery
  ) {
    const result = await runPluginDoctorRecovery(opts);
    defaultRuntime.log(
      opts.json
        ? JSON.stringify(result, null, 2)
        : [...result.changes, ...(result.notices ?? []), ...result.warnings].join("\n"),
    );
    return exitCliAfterOutput(defaultRuntime, result.warnings.length ? 1 : 0);
  }
  const inspection = await import("./plugins-cli.runtime.js");
  return await inspection.runPluginsDoctorCommand(opts);
}
