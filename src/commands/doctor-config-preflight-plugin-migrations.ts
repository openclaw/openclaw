import { existsSync } from "node:fs";
import { resolveDeferredPluginMigrationConfigPaths } from "../config/deferred-plugin-migration-config.js";
import { cloneEnvWithPlatformSemantics } from "../config/env-vars.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import { resolveConfigPath } from "../config/paths.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DeferredPluginMigrationConflictError,
  formatDeferredPluginMigration,
  mergeDeferredPluginMigration,
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
  MigrationLogger,
} from "../infra/state-migrations.types.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  inspectPluginMigrationAvailability,
  type PluginMigrationInspection,
} from "./doctor/shared/plugin-migration-availability.js";
import { readShippedPluginInstallConfigImportRecords } from "./doctor/shared/plugin-registry-migration.js";
import { shouldDeferConfiguredPluginInstallRepair } from "./doctor/shared/update-phase.js";

/** One preflight retains unavailable owners until their migration reports completion. */
export function createDoctorPluginMigrationPreparation(params: {
  enabled: boolean;
  env: () => NodeJS.ProcessEnv;
  beforePersistentEffect: () => void;
  report: (result: MigrationMessages) => void;
  recordReceipt: (receipt: LegacyStateMigrationStepReceipt) => void;
  measure: ConfigSnapshotReadMeasure;
  runWithPluginMetadataSnapshot: PluginMetadataSnapshotScopeRunner;
  doctorOnlyStateMigrations: boolean;
  log?: MigrationLogger;
}) {
  const previousById = new Map<string, DeferredPluginMigration>();
  let deferred: readonly DeferredPluginMigration[] = [];
  let expectedPending: readonly DeferredPluginMigration[] = [];
  let refreshSnapshot = false;
  let previousLoaded = false;
  const loadPrevious = async (snapshot?: ConfigFileSnapshot) => {
    if (previousLoaded) {
      return;
    }
    const env = cloneEnvWithPlatformSemantics(params.env());
    if (!(snapshot?.exists ?? existsSync(resolveConfigPath(env)))) {
      return;
    }
    deferred = await withArtifactPreservingStateReads(() =>
      withOpenClawStateDatabaseReadSnapshot(async () => readDeferredPluginMigrations({ env }), {
        env,
      }),
    );
    expectedPending = structuredClone(deferred);
    for (const entry of deferred) {
      previousById.set(entry.pluginId, entry);
    }
    previousLoaded = true;
  };
  let prepared = false;
  const completedIds = new Set<string>();
  const reported = new Map<string, LegacyStateMigrationStepReceipt>();
  let statelessPluginIds = new Set<string>();
  let runtimePluginAliases = new Set<string>();
  const inspectedStatelessPluginIds = new Set<string>();
  const learn = (inspection: PluginMigrationInspection | undefined) => {
    if (!inspection) {
      return;
    }
    statelessPluginIds = new Set(inspection.statelessPluginIds);
    runtimePluginAliases = new Set(inspection.runtimePluginAliases);
    for (const pluginId of inspection.requiredPluginIds) {
      const pending = previousById.get(pluginId);
      if (pending) {
        previousById.set(pluginId, { ...pending, requiresStateMigration: true });
      }
    }
    for (const pluginId of inspection.inspectionRequiredPluginIds) {
      const pending = previousById.get(pluginId);
      if (pending) {
        previousById.set(pluginId, { ...pending, requiresDoctorInspection: true });
      }
    }
  };
  const retain = (pending: DeferredPluginMigration) =>
    mergeDeferredPluginMigration(previousById.get(pending.pluginId), pending);
  const remember = () => {
    for (const pending of deferred) {
      previousById.set(pending.pluginId, pending);
    }
  };
  const prepare = async (snapshot: ConfigFileSnapshot) => {
    await loadPrevious(snapshot);
    if (!snapshot.exists) {
      return [...previousById.values()];
    }
    if (!prepared && params.enabled) {
      const availability = await inspectPluginMigrationAvailability({
        cfg: snapshot.sourceConfig,
        env: params.env(),
        installRecords: readShippedPluginInstallConfigImportRecords(snapshot, {
          env: params.env(),
        }),
        retainedPluginIds: [...previousById.keys()],
        deferInstallation: shouldDeferConfiguredPluginInstallRepair(params.env()),
      });
      learn(availability);
      deferred = availability.pending.map(retain);
      remember();
      prepared = true;
    }
    return [...previousById.values()];
  };
  const reportPending = (plugin: DeferredPluginMigration) => {
    const warning = formatDeferredPluginMigration(plugin, params.env());
    const previous = reported.get(plugin.pluginId);
    if (previous?.warnings[0] === warning) {
      return;
    }
    params.report({
      changes: [],
      warnings: [warning],
      warningDisposition: "recoverable",
      outcome: "deferred",
    });
    if (previous) {
      previous.warnings = [warning];
      return;
    }
    const receipt: LegacyStateMigrationStepReceipt = {
      id: `plugin:${plugin.pluginId}`,
      phase: "final",
      source: [{ kind: "owner", id: plugin.pluginId }],
      target: [{ kind: "owner", id: plugin.pluginId }],
      requiredness: "conditional",
      reversibility: "checkpoint-required",
      outcome: "deferred",
      changes: [],
      warnings: [warning],
    };
    reported.set(plugin.pluginId, receipt);
    params.recordReceipt(receipt);
  };
  const persistPending = (
    pending: readonly DeferredPluginMigration[],
    resolvedPluginIds?: readonly string[],
  ) => {
    params.beforePersistentEffect();
    try {
      const committed = recordDeferredPluginMigrations({
        env: params.env(),
        pending,
        ...(resolvedPluginIds ? { resolvedPluginIds } : {}),
        expectedPending,
      });
      if (committed) {
        expectedPending = structuredClone(committed);
      }
      return true;
    } catch (error) {
      if (!(error instanceof DeferredPluginMigrationConflictError)) {
        throw error;
      }
      expectedPending = structuredClone(error.pending);
      previousById.clear();
      deferred = error.pending;
      completedIds.clear();
      statelessPluginIds.clear();
      runtimePluginAliases.clear();
      inspectedStatelessPluginIds.clear();
      refreshSnapshot = true;
      for (const plugin of deferred) {
        previousById.set(plugin.pluginId, plugin);
        reportPending(plugin);
      }
      return false;
    }
  };

  return {
    deferred: () => deferred,
    hasPending: () => previousById.size > 0,
    prepare,
    snapshotOptions: async () => {
      // Existing pending inputs must reach the first config read before backup selection.
      await loadPrevious();
      return {
        preparePluginMigrations: !prepared && params.enabled ? prepare : undefined,
        deferredPluginMigrations: [...previousById.values()],
      };
    },
    async migrate(config: OpenClawConfig) {
      const { autoMigrateLegacyPluginDoctorState } =
        await import("../infra/state-migrations.plugin-doctor.js");
      params.report(
        await params.measure("plugin-doctor-migrations", () =>
          params.runWithPluginMetadataSnapshot({ config }, () =>
            autoMigrateLegacyPluginDoctorState({
              config,
              env: params.env(),
              log: params.log,
              ...(params.doctorOnlyStateMigrations ? { doctorOnlyStateMigrations: true } : {}),
            }),
          ),
        ),
      );
    },
    converged(
      pending: readonly DeferredPluginMigration[],
      snapshot: ConfigFileSnapshot,
      metadata: PluginMetadataSnapshot | undefined,
      inspection?: PluginMigrationInspection,
    ) {
      learn(inspection);
      deferred = pending.map((plugin) =>
        retain(
          Object.assign(
            resolveDeferredPluginMigrationConfigPaths({
              config: snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig,
              pluginId: plugin.pluginId,
              compatibilityMigrationPaths: metadata?.plugins.find(
                (record) => record.id === plugin.pluginId,
              )?.configContracts?.compatibilityMigrationPaths,
            }),
            plugin,
          ),
        ),
      );
      remember();
      if (!persistPending([...previousById.values()])) {
        return;
      }
      for (const plugin of deferred) {
        reportPending(plugin);
      }
    },
    observe(result: MigrationMessages) {
      for (const pluginId of result.requiredPluginIds ?? []) {
        const pending = previousById.get(pluginId);
        if (pending) {
          previousById.set(pluginId, { ...pending, requiresStateMigration: true });
        }
      }
      for (const pluginId of result.statelessPluginIds ?? []) {
        inspectedStatelessPluginIds.add(pluginId);
      }
      for (const pluginId of result.completedPluginIds ?? []) {
        completedIds.add(pluginId);
      }
    },
    complete() {
      if (!params.enabled) {
        return false;
      }
      const unavailableIds = new Set(deferred.map((plugin) => plugin.pluginId));
      const resolvedPluginIds = [...previousById.values()]
        .filter((plugin) => {
          if (completedIds.has(plugin.pluginId)) {
            return true;
          }
          if (plugin.requiresStateMigration || unavailableIds.has(plugin.pluginId)) {
            return false;
          }
          if (inspectedStatelessPluginIds.has(plugin.pluginId)) {
            return true;
          }
          if (plugin.requiresDoctorInspection) {
            return false;
          }
          // A runtime name has no plugin-owned inputs; the old collector could retain the
          // shared session locator even when no plugin migration existed for that name.
          return (
            statelessPluginIds.has(plugin.pluginId) ||
            (runtimePluginAliases.has(plugin.pluginId) &&
              !plugin.validationExcludedPaths?.length &&
              (plugin.configPaths ?? []).every(
                (segments) =>
                  segments.length === 2 && segments[0] === "session" && segments[1] === "store",
              ))
          );
        })
        .map((plugin) => plugin.pluginId);
      const resolvedIds = new Set(resolvedPluginIds);
      const pending = [...previousById.values()]
        .filter((plugin) => !resolvedIds.has(plugin.pluginId))
        .map((plugin) =>
          unavailableIds.has(plugin.pluginId)
            ? plugin
            : Object.assign(plugin, {
                reason:
                  "The installed plugin has not confirmed that its saved data and settings are ready for this version. If Doctor cannot finish the upgrade, report this warning to the plugin maintainer.",
                command: "openclaw doctor --fix",
              }),
        );
      if (resolvedPluginIds.length === 0 && pending.length === 0) {
        return refreshSnapshot;
      }
      if (!persistPending(pending, resolvedPluginIds)) {
        return true;
      }
      for (const pluginId of resolvedPluginIds) {
        previousById.delete(pluginId);
      }
      for (const plugin of pending) {
        previousById.set(plugin.pluginId, plugin);
        reportPending(plugin);
      }
      return refreshSnapshot || resolvedPluginIds.length > 0;
    },
  };
}
