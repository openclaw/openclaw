import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  prepareDoctorConfigReferenceSource,
  restoreDoctorConfigEnvRefs,
} from "../../commands/doctor/shared/config-flow-steps.js";
import { assertInstalledPluginIdRecoveryCurrent } from "../../commands/doctor/shared/installed-plugin-id-recovery.js";
import { runPostCorePluginConvergence } from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import { resolvePostCoreConvergenceEnv } from "../../commands/doctor/shared/update-phase.js";
import {
  getConfigValueAtPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "../../config/config-paths.js";
import { readConfigFileSnapshot, transformConfigFileWithRetry } from "../../config/config.js";
import {
  getDeferredPluginMigrationConfigFacts,
  setDeferredPluginMigrationConfigFacts,
} from "../../config/deferred-plugin-migration-config.js";
import { collectChangedConfigPaths } from "../../config/include-write-boundary.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { comparePackageUpdateVersions } from "../../infra/package-update-utils.js";
import { resolveRegistryUpdateChannel, type UpdateChannel } from "../../infra/update-channels.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery-types.js";
import { getLogger } from "../../logging/logger.js";
import type { PluginCapabilityConsentHandler } from "../../plugins/capability-consent.js";
import { commitPluginInstallRecordsWithConfig } from "../../plugins/install-record-commit.js";
import {
  copyPluginInstallTransactionRequest,
  requestDeferredPluginInstall,
  resolvePluginInstallOwnerMigrations,
  settlePluginInstallTransactions,
  type PluginInstallTransaction,
} from "../../plugins/install-transaction.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import { listPersistedBundledPluginLocationBridges } from "../../plugins/location-bridges.js";
import { isTrustedOfficialPluginInstallRecord } from "../../plugins/official-external-install-records.js";
import { VERSION_BOUND_RUNTIME_PLUGIN_IDS } from "../../plugins/official-runtime-plugins.js";
import type { MissingPluginInstallPayload } from "../../plugins/payload-verification.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "../../plugins/plugin-lifecycle-lease.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import { createPluginCohortPublication } from "../../plugins/update-cohort-recovery.js";
import { convergePluginReleaseCohort } from "../../plugins/update-cohort.js";
import {
  resolveExactNpmSpecVersion,
  resolveNpmSpecPackageName,
} from "../../plugins/update-source.js";
import { isClawHubTrustSkippedOutcome, type PluginUpdateOutcome } from "../../plugins/update.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { resolvePluginCapabilityConsentCliOptions } from "../plugin-capability-consent.js";
import { readPackageVersion } from "./shared.js";
import { withUpdateConfigWriteAuthority } from "./update-command-config.js";
import {
  buildInvalidConfigPostCoreUpdateResult,
  createPostCorePluginUpdateResult,
  createPluginUpdateWarning,
  type PluginUpdateWarning,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins-internals.js";

export type { PostCorePluginUpdateResult } from "./update-command-plugins-internals.js";

class PluginFinalizationConfigConflictError extends ConfigMutationConflictError {
  constructor(field: readonly string[]) {
    super(`Plugin finalization conflicts with changed config field ${field.join(".")}`, {
      retryable: false,
    });
  }
}

function formatMissingPluginPayloadReason(entry: MissingPluginInstallPayload): string {
  return entry.reason === "missing-install-path"
    ? "installPath is missing"
    : entry.reason === "missing-package-json"
      ? `package.json is missing under ${entry.installPath}`
      : `package directory is missing: ${entry.installPath}`;
}

export async function updatePluginsAfterCoreUpdate(params: {
  root: string;
  assertCurrent?: () => void;
  channel: UpdateChannel;
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  configBaseline?: OpenClawConfig;
  configWriteOptions: ConfigWriteOptions;
  configChanged?: boolean;
  restoredAuthoredChannels?: unknown;
  timeoutMs: number;
  workTimeoutMs?: number | null;
  pluginInstallRecords?: Record<string, PluginInstallRecord>;
  json?: boolean;
  acceptCapabilities?: boolean;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  runtime?: RuntimeEnv;
  cohort?: { runId: string; env: NodeJS.ProcessEnv; fence: UpdateRecoveryFence };
}): Promise<PostCorePluginUpdateResult> {
  if (!params.configSnapshot.valid) {
    params.assertCurrent?.();
    const invalid = buildInvalidConfigPostCoreUpdateResult(params.configSnapshot);
    if (!params.json) {
      const runtime = params.runtime ?? defaultRuntime;
      runtime.log(theme.error(invalid.message));
      for (const line of invalid.guidance) {
        runtime.log(theme.muted(`  ${line}`));
      }
    }
    return invalid.result;
  }
  // Same-run migration receipts are facts from this lease. Keep their owner
  // continuously held from cohort planning through final index/config publication.
  return await withPluginLifecycleLease({ assertCurrent: params.assertCurrent }, async (lease) => {
    const assertCurrent = () => {
      params.assertCurrent?.();
      lease.assertOwned();
    };
    const publication =
      params.cohort &&
      createPluginCohortPublication({
        ...params.cohort,
        fence: { assertCurrent },
        deferRecordPublication: true,
      });
    if (params.cohort && !publication) {
      throw new Error(
        "The outer updater did not retain the plugin cohort before activation; retry using the updated updater before changing plugins.",
      );
    }
    const transactions: PluginInstallTransaction[] = [];
    const owned = publication
      ? requestDeferredPluginInstall(
          { ...params, assertCurrent },
          transactions,
          assertCurrent,
          undefined,
          publication.observer,
        )
      : { ...params, assertCurrent };
    let result: PostCorePluginUpdateResult;
    try {
      result = await updatePluginsAfterCoreUpdateWithLease(owned, lease, publication);
    } catch (error) {
      await settlePluginInstallTransactions(transactions, "rollback", { error }, assertCurrent);
      if (
        error instanceof ConfigMutationConflictError &&
        (error.retryable || error instanceof PluginFinalizationConfigConflictError)
      ) {
        assertCurrent();
        const warning = {
          reason: "plugin-config-conflict",
          message:
            "Plugin finalization deferred because config changed. Run `openclaw plugins doctor` or `openclaw doctor --fix` to finish plugin repair.",
          guidance: ["openclaw plugins doctor", "openclaw doctor --fix"],
        };
        if (!params.json) {
          (params.runtime ?? defaultRuntime).log(theme.warn(warning.message));
        }
        return createPostCorePluginUpdateResult({ status: "warning", warnings: [warning] });
      }
      throw error;
    }
    // The matching records are published. Cleanup failure must not remove
    // packages underneath those records, including siblings not yet committed.
    await settlePluginInstallTransactions(transactions, "commit", undefined, assertCurrent);
    return result;
  });
}

async function updatePluginsAfterCoreUpdateWithLease(
  params: Parameters<typeof updatePluginsAfterCoreUpdate>[0],
  lease: PluginLifecycleLeaseContext,
  publication?: ReturnType<typeof createPluginCohortPublication>,
): Promise<PostCorePluginUpdateResult> {
  params.assertCurrent?.();
  const runtime = params.runtime ?? defaultRuntime;
  const referenceSource = prepareDoctorConfigReferenceSource(params.configSnapshot);
  const clawHubTrustNotices = new Set<string>();
  const loggedPluginWarnings = new Set<string>();
  const logPluginWarning = (message: string) => {
    const plain = stripAnsi(message);
    if (!params.json && !loggedPluginWarnings.has(plain)) {
      runtime.log(message.includes("╭─") ? message : theme.warn(message));
      loggedPluginWarnings.add(plain);
    }
  };
  const pluginLogger = {
    ...(params.json ? { terminalLinks: false } : {}),
    info: (msg: string) => {
      if (!params.json) {
        runtime.log(msg);
      }
    },
    warn: (msg: string) => {
      const plain = stripAnsi(msg);
      if (
        plain.includes("ClawHub Security Audit") &&
        (params.json || plain.includes("Outcome: Review"))
      ) {
        clawHubTrustNotices.add(plain);
      }
      if (plain.includes("ClawHub") && plain.includes("╭─")) {
        logPluginWarning(msg);
      }
    },
  };

  if (!params.json) {
    runtime.log("");
    runtime.log(theme.heading("Updating plugins..."));
  }

  let warnings: PluginUpdateWarning[] = [];
  const capabilityConsent = params.onCapabilityConsent
    ? { onCapabilityConsent: params.onCapabilityConsent }
    : resolvePluginCapabilityConsentCliOptions({
        acceptCapabilities: params.acceptCapabilities,
        action: "update",
        allowPrompt: !params.json,
        runtime,
      });
  const pluginInstallRecords =
    params.pluginInstallRecords ?? (await loadInstalledPluginIndexInstallRecords());
  const coreVersion = await readPackageVersion(params.root);
  const pluginUpdateChannel = resolveRegistryUpdateChannel({
    configChannel: params.channel,
    currentVersion: coreVersion,
  });
  const integrityDrifts: PostCorePluginUpdateResult["integrityDrifts"] = [];
  const pluginUpdateOutcomes: PluginUpdateOutcome[] = [];
  const collectPluginOutcome = (
    outcome: PluginUpdateOutcome,
    phase: "cohort" | "convergence" = "cohort",
  ) => {
    const fromCohort = phase === "cohort";
    if (fromCohort && outcome.status === "skipped" && outcome.code === "plugin-operator-managed") {
      warnings.push({
        pluginId: outcome.pluginId,
        source: outcome.rootDir,
        reason: outcome.code,
        message: outcome.message,
        guidance: outcome.guidance,
      });
    }
    pluginUpdateOutcomes.push(outcome);
    if (outcome.status !== "error" && !isClawHubTrustSkippedOutcome(outcome)) {
      return;
    }
    const includeWarningInReason =
      fromCohort &&
      (params.json || !outcome.warning || !loggedPluginWarnings.has(stripAnsi(outcome.warning)));
    const warning = createPluginUpdateWarning({
      ...(!fromCohort || (outcome.pluginId && outcome.pluginId !== "unknown")
        ? { pluginId: outcome.pluginId }
        : {}),
      reason:
        outcome.warning && includeWarningInReason
          ? `${outcome.warning}\n${outcome.message}`
          : outcome.message,
    });
    if (fromCohort || !warnings.some((entry) => entry.pluginId === warning.pluginId)) {
      warnings.push(warning);
    }
  };
  const collectMissingPayloadOutcome = (entry: MissingPluginInstallPayload) => {
    const warning = createPluginUpdateWarning({
      pluginId: entry.pluginId,
      reason: `Plugin install payload missing after update: ${formatMissingPluginPayloadReason(entry)}.`,
      kind: "load",
    });
    warnings.push(warning);
    pluginUpdateOutcomes.push({
      pluginId: entry.pluginId,
      status: "error",
      message: warning.message,
    });
  };

  const externalizedBundledPluginBridges = await listPersistedBundledPluginLocationBridges({
    workspaceDir: params.root,
  });
  params.assertCurrent?.();
  const cohort = await convergePluginReleaseCohort(
    copyPluginInstallTransactionRequest(params, {
      config: withPluginInstallRecords(params.configSnapshot.sourceConfig, pluginInstallRecords),
      channel: pluginUpdateChannel,
      coreVersion: coreVersion ?? undefined,
      versionBoundPluginIds: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
      timeoutMs: params.timeoutMs,
      workTimeoutMs: params.workTimeoutMs,
      workspaceDir: params.root,
      externalizedBundledPluginBridges,
      beforePersistentEffect: params.assertCurrent,
      logger: pluginLogger,
      onIntegrityDrift: async (drift) => {
        integrityDrifts.push({
          pluginId: drift.pluginId,
          spec: drift.spec,
          expectedIntegrity: drift.expectedIntegrity,
          actualIntegrity: drift.actualIntegrity,
          ...(drift.resolvedSpec ? { resolvedSpec: drift.resolvedSpec } : {}),
          ...(drift.resolvedVersion ? { resolvedVersion: drift.resolvedVersion } : {}),
          action: "aborted",
        });
        return false;
      },
      ...capabilityConsent,
    }),
  );
  params.assertCurrent?.();
  for (const error of cohort.sync.summary.errors) {
    collectPluginOutcome({ ...error, status: "error" });
  }
  for (const warning of cohort.sync.summary.warnings) {
    getLogger().warn(warning);
  }
  let pluginConfig = cohort.config;
  let pluginsChanged = cohort.changed || params.configChanged === true;
  for (const entry of cohort.missingPayloads) {
    collectMissingPayloadOutcome(entry);
  }
  pluginUpdateOutcomes.push(...cohort.repairOutcomes);
  for (const rawOutcome of cohort.updateOutcomes) {
    collectPluginOutcome(rawOutcome);
  }

  for (const entry of cohort.remainingMissingPayloads) {
    if (!cohort.repairedMissingPayloadIds.has(entry.pluginId)) {
      collectMissingPayloadOutcome(entry);
    }
  }

  // Convergence checks activation before restart. Seed it from the current
  // sync/npm records so repair cannot overwrite them with an older disk snapshot.
  const convergenceBaselineRecords = pluginConfig.plugins?.installs ?? {};
  // Keep the observed records stable if convergence replaces them.
  const probedRecords = new Map(
    cohort.updateOutcomes.map(({ pluginId }) => {
      const record = convergenceBaselineRecords[pluginId];
      return [pluginId, record ? { ...record } : undefined];
    }),
  );
  const convergenceEnv = resolvePostCoreConvergenceEnv(process.env, coreVersion ?? undefined);
  const convergence = await runPostCorePluginConvergence(
    copyPluginInstallTransactionRequest(params, {
      cfg: pluginConfig,
      timeoutMs: params.timeoutMs,
      workTimeoutMs: params.workTimeoutMs,
      configPersistence: "caller",
      env: convergenceEnv,
      compatibilityHostVersion: coreVersion ?? undefined,
      baselineInstallRecords: convergenceBaselineRecords,
      beforePersistentEffect: params.assertCurrent,
      ...capabilityConsent,
    }),
  );
  params.assertCurrent?.();
  const repairedPluginIds = new Set([
    ...[...cohort.repairOutcomes, ...cohort.updateOutcomes]
      .filter((outcome) => outcome.status === "updated" || outcome.status === "unchanged")
      .map((outcome) => outcome.pluginId),
    ...(convergence.repairedPluginIds ?? []),
  ]);
  warnings = warnings.filter(
    (warning) => !warning.pluginId || !repairedPluginIds.has(warning.pluginId),
  );
  for (const pluginId of convergence.repairedPluginIds ?? []) {
    const before = convergenceBaselineRecords[pluginId];
    const after = convergence.installRecords[pluginId];
    pluginUpdateOutcomes.push({
      pluginId,
      status: "updated",
      currentVersion: before?.resolvedVersion ?? before?.version,
      nextVersion: after?.resolvedVersion ?? after?.version,
      message: `Repaired plugin "${pluginId}".`,
    });
  }
  for (const change of convergence.changes) {
    if (!params.json) {
      runtime.log(theme.muted(change));
    }
  }
  const convergenceWarnings = convergence.warnings.map((warning) =>
    createPluginUpdateWarning({
      ...warning,
      kind: warning.kind === "repair" ? "update" : warning.kind,
    }),
  );
  const convergenceOutcomes: PluginUpdateOutcome[] = [
    ...(convergence.outcomes ?? []),
    ...convergence.warnings.flatMap((warning): PluginUpdateOutcome[] =>
      warning.pluginId
        ? [{ pluginId: warning.pluginId, status: "error", message: warning.message }]
        : [],
    ),
  ];
  warnings.push(...convergenceWarnings, ...(convergence.notices ?? []));
  for (const outcome of convergenceOutcomes) {
    collectPluginOutcome(outcome, "convergence");
  }

  // Repair already persisted this authoritative map; the commit below must not
  // restore the pre-convergence records and discard successful repairs.
  pluginConfig = withPluginInstallRecords(convergence.config, convergence.installRecords);
  // Report retention only while the probed install survives convergence.
  for (const outcome of cohort.updateOutcomes) {
    const record = convergence.installRecords[outcome.pluginId];
    const probed = probedRecords.get(outcome.pluginId);
    if (
      outcome.status !== "unchanged" ||
      !outcome.currentVersion ||
      !record ||
      record.source !== probed?.source ||
      record.spec !== probed.spec
    ) {
      continue;
    }
    const unavailable = outcome.code === "plugin-target-unavailable";
    if (
      unavailable
        ? record.installPath !== probed?.installPath ||
          record.version !== probed?.version ||
          record.resolvedVersion !== probed?.resolvedVersion
        : record.source !== "npm" ||
          !outcome.nextVersion ||
          comparePackageUpdateVersions(outcome.nextVersion, outcome.currentVersion) <= 0 ||
          (record.resolvedVersion ?? record.version) !== outcome.currentVersion ||
          resolveExactNpmSpecVersion(record.spec) !== outcome.currentVersion ||
          !isTrustedOfficialPluginInstallRecord({
            pluginId: outcome.pluginId,
            packageName: resolveNpmSpecPackageName(record.spec),
            record,
          })
    ) {
      continue;
    }
    const message = unavailable
      ? outcome.message
      : `Plugin update retained an official plugin pin: ${outcome.message}`;
    warnings.push({
      pluginId: outcome.pluginId,
      reason: unavailable ? "plugin-target-unavailable" : "retained-plugin-pin",
      message,
      guidance: unavailable
        ? [formatCliCommand(`openclaw plugins update ${outcome.pluginId}`)]
        : ["Keep the pin if intentional; replacing it is an explicit operator choice."],
    });
    if (unavailable) {
      getLogger().warn(message);
    }
  }
  pluginsChanged ||= convergence.changes.length > 0 || convergence.configChanges.length > 0;

  if (pluginsChanged) {
    const nextInstallRecords = pluginConfig.plugins?.installs ?? {};
    // Old npm generations remain discoverable until final commit retires them.
    // Same-run reference moves use updater facts, not durable-recovery absence checks.
    const appliedPluginIdMigrations = Object.fromEntries(
      Object.entries(resolvePluginInstallOwnerMigrations(cohort) ?? {}).filter(
        ([fromId, toId]) =>
          !Object.hasOwn(nextInstallRecords, fromId) && Object.hasOwn(nextInstallRecords, toId),
      ),
    );
    const installedPluginIdRecovery = convergence.installedPluginIdRecovery;
    let nextConfig = withoutPluginInstallRecords(pluginConfig);
    if (referenceSource) {
      referenceSource.installedPluginIdRecovery = installedPluginIdRecovery;
      nextConfig = restoreDoctorConfigEnvRefs(
        nextConfig,
        referenceSource,
        params.configWriteOptions.explicitSetPaths,
        { appliedPluginIdMigrations },
      );
    }
    if (params.restoredAuthoredChannels !== undefined) {
      nextConfig = {
        ...nextConfig,
        channels: structuredClone(params.restoredAuthoredChannels) as OpenClawConfig["channels"],
      };
    }
    // Install-record and authored-channel rewrites create new config identities.
    // Keep the same deferred generation that admitted the original source snapshot.
    setDeferredPluginMigrationConfigFacts(
      nextConfig,
      getDeferredPluginMigrationConfigFacts(params.configSnapshot.sourceConfig),
    );
    // Installed plugin metadata can own migrations that this process has not loaded yet.
    // Finalization runs fresh doctor plus strict validation before the update can complete.
    const guardedWriteOptions = withUpdateConfigWriteAuthority(
      params.configWriteOptions,
      params.assertCurrent,
    );
    const assertCurrent = () => {
      guardedWriteOptions.assertCurrent?.();
      lease.assertOwned();
    };
    const assertRecoveryCurrent = () =>
      assertInstalledPluginIdRecoveryCurrent(
        params.configSnapshot.sourceConfig,
        installedPluginIdRecovery,
        convergenceEnv,
      );
    assertCurrent();
    await assertRecoveryCurrent();
    assertCurrent();
    await publication?.beforePublication();
    assertCurrent();
    // Package work can outlive its planning snapshot. Refresh provenance under the
    // config lock and retry only publication, never package installs or migrations.
    const mutationWriteOptions = { ...guardedWriteOptions };
    delete mutationWriteOptions.envSnapshotForRestore;
    delete mutationWriteOptions.includeFileHashesForWrite;
    delete mutationWriteOptions.includeFileTargetsForWrite;
    delete mutationWriteOptions.baseSnapshot;
    delete mutationWriteOptions.basePluginMetadataSnapshot;
    const baselineSource = withoutPluginInstallRecords(
      params.configBaseline ?? params.configSnapshot.sourceConfig,
    );
    const baselineReferences = prepareDoctorConfigReferenceSource(params.configSnapshot);
    const baseline = baselineReferences
      ? restoreDoctorConfigEnvRefs(baselineSource, baselineReferences)
      : baselineSource;
    const changedPaths = collectChangedConfigPaths(baseline, nextConfig).paths;
    await transformConfigFileWithRetry({
      writeOptions: {
        ...mutationWriteOptions,
        observe: false,
        assertCurrent,
        beforeCommit: async () => {
          assertCurrent();
          await params.configWriteOptions.beforeCommit?.();
          assertCurrent();
          await assertRecoveryCurrent();
          assertCurrent();
        },
        inputBase: "source",
        skipPluginValidation: true,
      },
      transform: (current, { snapshot }) => {
        const currentReferences = prepareDoctorConfigReferenceSource(snapshot);
        const currentConfig = currentReferences
          ? restoreDoctorConfigEnvRefs(current, currentReferences)
          : current;
        const candidate = structuredClone(currentConfig);
        for (const changedPath of changedPaths) {
          const before = getConfigValueAtPath(baseline, changedPath);
          const after = getConfigValueAtPath(nextConfig, changedPath);
          const value = getConfigValueAtPath(currentConfig, changedPath);
          const parentChanged = changedPath.slice(0, -1).some((_, index) => {
            const parent = changedPath.slice(0, index + 1);
            return (
              isRecord(getConfigValueAtPath(baseline, parent)) &&
              !isRecord(getConfigValueAtPath(currentConfig, parent))
            );
          });
          if (
            !isDeepStrictEqual(value, after) &&
            (parentChanged || !isDeepStrictEqual(value, before))
          ) {
            throw new PluginFinalizationConfigConflictError(changedPath);
          }
          if (after === undefined) {
            unsetConfigValueAtPath(candidate, [...changedPath]);
          } else {
            setConfigValueAtPath(candidate, changedPath, structuredClone(after));
          }
        }
        setDeferredPluginMigrationConfigFacts(
          candidate,
          getDeferredPluginMigrationConfigFacts(nextConfig),
        );
        return { nextConfig: candidate };
      },
      commit: async ({ nextConfig: candidate, baseHash, writeOptions }) => {
        const { configWrite } = await commitPluginInstallRecordsWithConfig({
          beforePersistentEffect: assertCurrent,
          previousInstallRecords: pluginInstallRecords,
          nextInstallRecords,
          nextConfig: candidate,
          baseHash,
          writeOptions,
        });
        return {
          config: configWrite.nextConfig,
          persistedHash: configWrite.persistedHash,
          persistedSourceConfig: configWrite.persistedSourceConfig,
          afterWrite: configWrite.afterWrite,
        };
      },
    });
    if (!params.json) {
      for (const change of convergence.configChanges) {
        runtime.log(theme.muted(change));
      }
    }
    params.assertCurrent?.();
    await refreshPluginRegistryAfterConfigMutation({
      configPath: params.configSnapshot.path,
      reason: "source-changed",
      workspaceDir: params.root,
      installRecords: nextInstallRecords,
      invalidateRuntimeCache: false,
      logger: pluginLogger,
      lease,
    });
    params.assertCurrent?.();
  }

  for (const notice of clawHubTrustNotices) {
    if (warnings.some((warning) => warning.reason.includes(notice))) {
      continue;
    }
    warnings.push({
      reason: notice,
      message: notice,
      guidance: [],
    });
  }

  const finalPluginOutcomes = [
    ...new Map(pluginUpdateOutcomes.map((outcome) => [outcome.pluginId, outcome])).values(),
  ];
  const status =
    warnings.length > 0 ||
    cohort.sync.summary.warnings.length > 0 ||
    finalPluginOutcomes.some((outcome) => outcome.status === "error")
      ? "warning"
      : "ok";
  const result: PostCorePluginUpdateResult = {
    status,
    changed: pluginsChanged,
    warnings,
    sync: {
      changed: cohort.sync.changed,
      switchedToBundled: cohort.sync.summary.switchedToBundled,
      switchedToNpm: cohort.sync.summary.switchedToNpm,
      warnings: cohort.sync.summary.warnings,
      errors: cohort.sync.summary.errors.map((error) => error.message),
    },
    npm: {
      changed: cohort.npmChanged,
      outcomes: pluginUpdateOutcomes,
    },
    integrityDrifts,
  };

  if (params.json) {
    return result;
  }

  const summarizeList = (list: string[]) =>
    list.length <= 6 ? list.join(", ") : `${list.slice(0, 6).join(", ")} +${list.length - 6} more`;

  for (const [label, plugins] of [
    ["Switched to bundled plugins", cohort.sync.summary.switchedToBundled],
    ["Restored plugins", cohort.sync.summary.switchedToNpm],
  ] as const) {
    if (plugins.length > 0) {
      runtime.log(theme.muted(`${label}: ${summarizeList(plugins)}.`));
    }
  }
  for (const warning of cohort.sync.summary.warnings) {
    logPluginWarning(warning);
  }
  const updated = finalPluginOutcomes.filter((entry) => entry.status === "updated").length;
  const unchanged = finalPluginOutcomes.filter((entry) => entry.status === "unchanged").length;
  const failed = finalPluginOutcomes.filter((entry) => entry.status === "error").length;
  const skipped = finalPluginOutcomes.filter((entry) => entry.status === "skipped").length;

  if (pluginUpdateOutcomes.length === 0 && warnings.length === 0) {
    runtime.log(theme.muted("No plugin updates needed."));
  } else if (pluginUpdateOutcomes.length > 0) {
    const parts = [`${updated} updated`, `${unchanged} unchanged`];
    if (failed > 0) {
      parts.push(`${failed} to retry`);
    }
    if (skipped > 0) {
      parts.push(`${skipped} skipped`);
    }
    runtime.log(theme.muted(`Plugin updates: ${parts.join(", ")}.`));
  }
  for (const outcome of finalPluginOutcomes) {
    if (outcome.status === "skipped") {
      runtime.log(theme.muted(`${outcome.pluginId}: ${outcome.message}`));
    }
  }

  for (const warning of warnings) {
    logPluginWarning(warning.message);
  }

  return result;
}
