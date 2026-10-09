import fs, { existsSync } from "node:fs";
import {
  hasDeferredPluginMigrationConfig,
  resolveDeferredPluginMigrationConfigPaths,
} from "../config/deferred-plugin-migration-config.js";
import { cloneEnvWithPlatformSemantics } from "../config/env-vars.js";
import { createConfigIO } from "../config/io.factory.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import { assertBaseSnapshotStillCurrent } from "../config/io.write-safety.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import { resolveConfigPath } from "../config/paths.js";
import { describeConfigSnapshotInputChange } from "../config/snapshot-inputs.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withConfigSourceLocks } from "../config/write-lock.js";
import {
  DeferredPluginMigrationConflictError,
  formatDeferredPluginMigration,
  mergeDeferredPluginMigration,
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  type DeferredPluginMigration,
  type DeferredPluginMigrationRecordInput,
} from "../infra/deferred-plugin-migrations.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
  MigrationLogger,
} from "../infra/state-migrations.types.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  inspectPluginMigrationAvailability,
  type PluginMigrationInspection,
} from "./doctor/shared/plugin-migration-availability.js";
import { shouldDeferConfiguredPluginInstallRepair } from "./doctor/shared/update-phase.js";

/** One preflight retains unavailable owners until their migration reports completion. */
export function createDoctorPluginMigrationPreparation(params: {
  enabled: boolean;
  env: () => NodeJS.ProcessEnv;
  report: (result: MigrationMessages) => void;
  recordReceipt: (receipt: LegacyStateMigrationStepReceipt) => void;
  measure: ConfigSnapshotReadMeasure;
  runWithPluginMetadataSnapshot: PluginMetadataSnapshotScopeRunner;
  doctorOnlyStateMigrations: boolean;
  log?: MigrationLogger;
}) {
  const shouldDeferInstallation = () =>
    Boolean(resolveUpdateRehearsalRoot(params.env())) ||
    shouldDeferConfiguredPluginInstallRepair(params.env());
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
  let unavailablePluginIds = new Set<string>();
  let replacementPluginIds: Readonly<Record<string, string>> = {};
  let sourceSnapshot: ConfigFileSnapshot | undefined;
  const inspectedStatelessPluginIds = new Set<string>();
  const requirePlugins = (
    pluginIds: readonly string[],
    requirement: "requiresStateMigration" | "requiresDoctorInspection",
  ) => {
    for (const pluginId of pluginIds) {
      const pending = previousById.get(pluginId);
      if (pending) {
        previousById.set(pluginId, { ...pending, [requirement]: true });
      }
    }
  };
  const learn = (inspection: PluginMigrationInspection | undefined) => {
    if (!inspection) {
      return;
    }
    statelessPluginIds = new Set(inspection.statelessPluginIds);
    runtimePluginAliases = new Set(inspection.runtimePluginAliases);
    unavailablePluginIds = new Set(inspection.unavailablePluginIds);
    replacementPluginIds = inspection.replacementPluginIds ?? {};
    requirePlugins(inspection.requiredPluginIds, "requiresStateMigration");
    requirePlugins(inspection.inspectionRequiredPluginIds, "requiresDoctorInspection");
  };
  const retain = (pending: DeferredPluginMigration) =>
    mergeDeferredPluginMigration(previousById.get(pending.pluginId), pending);
  const remember = () => {
    for (const pending of deferred) {
      previousById.set(pending.pluginId, pending);
    }
  };
  const prepare = async (snapshot: ConfigFileSnapshot) => {
    sourceSnapshot = snapshot;
    await loadPrevious(snapshot);
    if (!snapshot.exists) {
      return [...previousById.values()];
    }
    if (!prepared && params.enabled) {
      const availability = await inspectPluginMigrationAvailability({
        cfg: snapshot.sourceConfig,
        env: params.env(),
        retainedPluginIds: [...previousById.keys()],
        deferInstallation: shouldDeferInstallation(),
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
  const persistPending = async (
    pending: readonly DeferredPluginMigration[],
    resolvedPluginIds?: readonly string[],
    settlements?: DeferredPluginMigrationRecordInput["settlements"],
  ) => {
    try {
      const committed = await recordDeferredPluginMigrations({
        env: params.env(),
        pending,
        ...(resolvedPluginIds ? { resolvedPluginIds } : {}),
        ...(settlements ? { settlements } : {}),
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
      unavailablePluginIds.clear();
      replacementPluginIds = {};
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
    retainedPluginIds: () => [...previousById.keys()],
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
    async converged(
      pending: readonly DeferredPluginMigration[],
      snapshot: ConfigFileSnapshot,
      metadata: PluginMetadataSnapshot | undefined,
      inspection?: PluginMigrationInspection,
    ) {
      sourceSnapshot = snapshot;
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
      if (!(await persistPending([...previousById.values()]))) {
        return;
      }
      for (const plugin of deferred) {
        reportPending(plugin);
      }
    },
    observe(result: MigrationMessages) {
      requirePlugins(result.requiredPluginIds ?? [], "requiresStateMigration");
      for (const pluginId of result.statelessPluginIds ?? []) {
        inspectedStatelessPluginIds.add(pluginId);
      }
      for (const pluginId of result.completedPluginIds ?? []) {
        completedIds.add(pluginId);
      }
    },
    async complete() {
      if (!params.enabled) {
        return false;
      }
      const unavailableIds = new Set(deferred.map((plugin) => plugin.pluginId));
      const installationDeferred = shouldDeferInstallation();
      const sourceConfig =
        sourceSnapshot?.sourceConfigBeforeMigrations ?? sourceSnapshot?.sourceConfig;
      const settlements: NonNullable<DeferredPluginMigrationRecordInput["settlements"]>[number][] =
        [];
      const resolvedPluginIds = [...previousById.values()]
        .filter((plugin) => {
          if (completedIds.has(plugin.pluginId)) {
            return true;
          }
          if (
            unavailablePluginIds.has(plugin.pluginId) &&
            sourceSnapshot?.valid &&
            sourceConfig &&
            !installationDeferred &&
            !hasDeferredPluginMigrationConfig(sourceConfig, plugin)
          ) {
            const successor = replacementPluginIds[plugin.pluginId];
            if (successor && completedIds.has(successor)) {
              settlements.push({
                pluginId: plugin.pluginId,
                status: "superseded",
                reason: `Superseded by plugin "${successor}", which completed its migration. Existing state has been kept.`,
              });
              return true;
            }
            // Empty settings do not fulfill an explicit request to install or repair a plugin.
            const explicitlyEnabled =
              sourceConfig.plugins?.entries?.[plugin.pluginId]?.enabled === true &&
              passesManifestOwnerBasePolicy({
                plugin: { id: plugin.pluginId },
                normalizedConfig: normalizePluginsConfig(sourceConfig.plugins),
              });
            if (
              !explicitlyEnabled &&
              !plugin.requiresStateMigration &&
              !plugin.requiresDoctorInspection
            ) {
              settlements.push({
                pluginId: plugin.pluginId,
                status: "completed",
                reason:
                  "Not applicable: the plugin owner is unavailable and there is no protected config to migrate. Existing state has been kept.",
              });
              return true;
            }
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
          unavailablePluginIds.has(plugin.pluginId) && !installationDeferred
            ? Object.assign(plugin, {
                reason: `The migration owner is unavailable. Install or enable plugin "${plugin.pluginId}" to migrate its retained data and settings. For a retired plugin, ask its maintainer for a supported migration or recovery path.`,
              })
            : unavailableIds.has(plugin.pluginId)
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
      const persist = () => persistPending(pending, resolvedPluginIds, settlements);
      let committed: boolean;
      if (settlements.length > 0 && sourceSnapshot) {
        const env = cloneEnvWithPlatformSemantics(params.env());
        const { snapshot, writeOptions } = await createConfigIO({
          env,
          observe: false,
          pluginValidation: "core-only",
          deferredPluginMigrations: expectedPending,
          shellEnvFallback: "defer",
        }).readConfigFileSnapshotForWrite();
        if (
          !snapshot.valid ||
          describeConfigSnapshotInputChange(sourceSnapshot, snapshot, {
            compareResolvedConfig: false,
          })
        ) {
          throw new ConfigMutationConflictError(
            "Plugin migration source config changed or could not be read; rerun Doctor.",
          );
        }
        const includeGraph = {
          hashes: writeOptions.includeFileHashesForWrite ?? {},
          targets: writeOptions.includeFileTargetsForWrite ?? {},
        };
        const assertCurrent = () =>
          assertBaseSnapshotStillCurrent(snapshot, resolveConfigPath(env), fs, includeGraph);
        // The existing source and lifecycle owners fence config edits and package replacement
        // through the worker's lease grants; the ledger also compares its pending generation.
        committed = await withPluginLifecycleLease({ env, assertCurrent }, () =>
          withConfigSourceLocks(
            [snapshot.path, ...Object.entries(includeGraph.targets).flat()],
            persist,
            env,
            assertCurrent,
          ),
        );
      } else {
        committed = await persist();
      }
      if (!committed) {
        return true;
      }
      for (const pluginId of resolvedPluginIds) {
        previousById.delete(pluginId);
        const receipt = reported.get(pluginId);
        if (receipt) {
          receipt.outcome = "completed";
          receipt.warnings = [];
        }
      }
      deferred = deferred.filter((plugin) => !resolvedIds.has(plugin.pluginId));
      if (settlements.length > 0) {
        params.report({
          changes: [],
          warnings: [],
          notices: settlements.map((entry) => `Plugin "${entry.pluginId}": ${entry.reason}`),
        });
      }
      for (const plugin of pending) {
        previousById.set(plugin.pluginId, plugin);
        reportPending(plugin);
      }
      return refreshSnapshot || resolvedPluginIds.length > 0;
    },
  };
}
