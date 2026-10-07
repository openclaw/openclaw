import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { assertDirectoryIdentitySync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { stripAnsi } from "../../../../packages/terminal-core/src/ansi.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import {
  capturePathRemovalGuard,
  isRemovalIoError,
  removePathWithinRoot,
} from "../../../infra/fs-safe-remove.js";
import { retainMutationAuthority } from "../../../infra/mutation-authority.js";
import type { PluginCapabilityConsentHandler } from "../../../plugins/capability-consent.js";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "../../../plugins/config-state.js";
import { formatSourceBundledPluginNotice } from "../../../plugins/dev-source-root.js";
import {
  attachPluginInstallTransaction,
  copyPluginInstallTransactionRequest,
  retainPluginInstallTransaction,
  withPluginInstallTransactions,
} from "../../../plugins/install-transaction.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../../../plugins/install-types.js";
import { hashStableJson } from "../../../plugins/installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../../plugins/installed-plugin-index-policy.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "../../../plugins/installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndexSync } from "../../../plugins/installed-plugin-index-store.js";
import {
  clearRetainedManagedNpmInstallMarker,
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
} from "../../../plugins/managed-npm-retention.js";
import { isPayloadMissing } from "../../../plugins/payload-verification.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "../../../plugins/plugin-lifecycle-lease.js";
import {
  isClawHubTrustSkippedOutcome,
  updateNpmInstalledPlugins,
  type PluginUpdateOutcome,
} from "../../../plugins/update.js";
import { resolveUserPath } from "../../../utils.js";
import { VERSION_BOUND_RUNTIME_PLUGIN_IDS } from "./configured-runtime-plugin-installs.js";
import {
  collectDownloadableInstallCandidates,
  collectUpdateDeferredPluginIds,
  resolveConfiguredPluginInstallContext,
} from "./missing-configured-plugin-install.candidates.js";
import {
  collectBlockedPluginIds,
  collectConfiguredChannelIds,
  collectConfiguredPluginIds,
} from "./missing-configured-plugin-install.ids.js";
import {
  installCandidate,
  isClawHubReviewNotice,
} from "./missing-configured-plugin-install.install.js";
import {
  forceNpmInstallRecordRepair,
  installPathsEqual,
  recordMatchesBundledPackage,
  resolveSafeBrokenOfficialInstallRemovalPath,
} from "./missing-configured-plugin-install.records.js";
import {
  resolveConfiguredPluginCandidateRepair,
  resolveConfiguredPluginRepairVersions,
} from "./missing-configured-plugin-install.targets.js";
import { shouldDeferConfiguredPluginInstallRepair } from "./update-phase.js";

type PluginInstallRepairWarning = {
  message: string;
  pluginId?: string;
};

type RepairMissingPluginInstallsResult = {
  changes: string[];
  /** User-facing notices from successful repairs that still need operator review. */
  notices?: string[];
  warnings: string[];
  /** Unresolved consent errors, kept typed for update finalization. */
  outcomes?: PluginUpdateOutcome[];
  repairedPluginIds?: string[];
  /** Successful install-record or package repairs that invalidate retained metadata. */
  pluginInventoryChanged?: true;
  /** User-facing details for repairs explicitly deferred until post-core convergence. */
  deferredRepairDetails?: string[];
  /** Plugin ids whose install repair failed and should be preserved from cleanup passes. */
  failedPluginIds?: string[];
  /**
   * The full install-record map after repair. Equal to the input
   * `baselineRecords` (or the disk-loaded records when no baseline was
   * provided) plus any mutations (newly-installed payloads, removed stale
   * bundled records). Callers that need to subsequently overwrite the
   * persisted index MUST seed their write from this map — the disk has
   * already been written to with the same set, but the in-memory caller
   * state is stale otherwise.
   */
  records: Record<string, PluginInstallRecord>;
};

type PluginInstallRepairOptions = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  workTimeoutMs?: number | null;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  onWarning?: (warning: PluginInstallRepairWarning) => void;
  beforePersistentEffect?: () => void | Promise<void>;
  /**
   * Optional pre-seeded records. When provided, this map is used instead of
   * the disk-loaded install-record snapshot. Pass the in-memory records
   * from earlier post-core steps (sync/npm) so this repair pass can layer
   * its mutations on top of them rather than reading a stale disk
   * snapshot. The merged result is persisted before this function returns.
   */
  baselineRecords?: Record<string, PluginInstallRecord>;
};

export async function repairMissingConfiguredPluginInstalls(
  params: PluginInstallRepairOptions & { repairVersionDrift?: boolean },
): Promise<RepairMissingPluginInstallsResult> {
  return repairMissingPluginInstalls(
    copyPluginInstallTransactionRequest(params, {
      ...params,
      pluginIds: collectConfiguredPluginIds(params.cfg, params.env),
      channelIds: collectConfiguredChannelIds(params.cfg, params.env),
      blockedPluginIds: collectBlockedPluginIds(params.cfg),
    }),
  );
}

export async function repairMissingPluginInstallsForIds(
  params: PluginInstallRepairOptions & {
    pluginIds: Iterable<string>;
    channelIds?: Iterable<string>;
    blockedPluginIds?: Iterable<string>;
  },
): Promise<RepairMissingPluginInstallsResult> {
  return repairMissingPluginInstalls(
    copyPluginInstallTransactionRequest(params, {
      ...params,
      pluginIds: new Set(normalizeTrimmedStringList([...params.pluginIds])),
      channelIds: new Set(normalizeTrimmedStringList([...(params.channelIds ?? [])])),
      blockedPluginIds: new Set(normalizeTrimmedStringList([...(params.blockedPluginIds ?? [])])),
    }),
  );
}

async function repairMissingPluginInstalls(
  params: PluginInstallRepairOptions & {
    pluginIds: ReadonlySet<string>;
    channelIds: ReadonlySet<string>;
    blockedPluginIds?: ReadonlySet<string>;
    repairVersionDrift?: boolean;
  },
): Promise<RepairMissingPluginInstallsResult> {
  // Baseline, awaited review, package publication, and the index write share one generation.
  return await withPluginLifecycleLease({ env: params.env }, (lease) =>
    withPluginInstallTransactions(
      params,
      () => lease.assertOwned(),
      async (owned, assertCurrent) => {
        const dependencyRepairMarkers = new Map<string, string>();
        let result: RepairMissingPluginInstallsResult | undefined;
        let failure: unknown;
        try {
          result = await repairMissingPluginInstallsWithLease(
            owned,
            lease,
            dependencyRepairMarkers,
            assertCurrent,
          );
        } catch (error) {
          failure = error;
        }
        // Markers belong to this repair only; never remove pre-existing retention.
        const cleanupErrors: unknown[] = [];
        for (const [pluginId, packageDir] of dependencyRepairMarkers) {
          if (result?.repairedPluginIds?.includes(pluginId)) {
            continue;
          }
          try {
            await clearRetainedManagedNpmInstallMarker(packageDir, assertCurrent);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (!result) {
          if (cleanupErrors.length > 0) {
            throw new AggregateError(
              [failure, ...cleanupErrors],
              "Plugin dependency repair failed and its retention markers could not be cleared.",
            );
          }
          throw failure;
        }
        result.warnings.push(
          ...cleanupErrors.map(
            (error) => `Failed to clear dependency repair retention marker: ${String(error)}`,
          ),
        );
        return result;
      },
    ),
  );
}

async function repairMissingPluginInstallsWithLease(
  params: Parameters<typeof repairMissingPluginInstalls>[0],
  lease: PluginLifecycleLeaseContext,
  dependencyRepairMarkers: Map<string, string>,
  assertCurrent: () => void,
): Promise<RepairMissingPluginInstallsResult> {
  const env = params.env ?? process.env;
  const installContext = await resolveConfiguredPluginInstallContext({
    cfg: params.cfg,
    env,
    configuredPluginIds: params.pluginIds,
    configuredChannelIds: params.channelIds,
    blockedPluginIds: params.blockedPluginIds,
    baselineRecords: params.baselineRecords,
  });
  const {
    knownIds,
    configuredChannelOwnerPluginIds,
    bundledPluginsById,
    configuredPluginIdsWithStaleDescriptors,
    operatorManagedPluginIds,
    stalePathInstallPluginIds,
    records,
    persistedRecords,
    updateChannel,
    installedPluginIdsWithRepairablePackageDiagnostics,
    installedPluginIdsWithStaleVersionBoundRuntimePackages,
    installedPluginIdsWithRepairablePackages,
    installedPluginMissingRequiredDependencies,
    officialReplacementPluginIds,
  } = installContext;
  const changes: string[] = [];
  const notices: string[] = [];
  const warnings: string[] = [];
  const warn = (message: string, pluginId?: string) => {
    warnings.push(message);
    params.onWarning?.({ message, ...(pluginId ? { pluginId } : {}) });
  };
  const sourceOutcomes: PluginUpdateOutcome[] = [];
  const deferredRepairDetails: string[] = [];
  const failedPlugins = new Map<string, PluginUpdateOutcome | undefined>();
  const repairedPluginIds = new Set<string>();
  const { coreVersion, cohortSpecs, newerRecordedPluginIds, driftedPluginIds } =
    resolveConfiguredPluginRepairVersions({
      cfg: params.cfg,
      env,
      context: installContext,
      repairVersionDrift: params.repairVersionDrift,
      onWarning: warn,
    });
  const deferredPluginIds = new Set<string>();
  let nextRecords = records;
  const normalizedPluginConfig = normalizePluginsConfig(params.cfg.plugins);
  const recordFailure = (pluginId: string, messages: string[], code?: string) => {
    // A later failed attempt does not resolve an earlier consent refusal.
    let outcome = failedPlugins.get(pluginId);
    const retainedEnabledInstall =
      (code === PLUGIN_CAPABILITY_CONSENT_REQUIRED ||
        code === PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE) &&
      knownIds.has(pluginId) &&
      !isPayloadMissing(env, records[pluginId]?.installPath) &&
      !installedPluginIdsWithRepairablePackageDiagnostics.has(pluginId) &&
      !installedPluginMissingRequiredDependencies.has(pluginId) &&
      !configuredPluginIdsWithStaleDescriptors.has(pluginId) &&
      resolveEffectiveEnableState({
        id: pluginId,
        origin: "global",
        config: normalizedPluginConfig,
        rootConfig: params.cfg,
      }).enabled;
    // Deferred replacements leave the installed artifact for the caller's payload smoke check.
    if (retainedEnabledInstall) {
      notices.push(
        `Kept installed plugin "${pluginId}"; replacement deferred. ${messages.join(" ")}`,
      );
    } else {
      for (const message of messages) {
        warn(message, pluginId);
      }
      if (code === PLUGIN_CAPABILITY_CONSENT_REQUIRED) {
        outcome = { pluginId, status: "error", code, message: messages.join(" ") };
      }
    }
    failedPlugins.set(pluginId, outcome);
  };

  for (const [pluginId, record] of Object.entries(records)) {
    const bundled = bundledPluginsById.get(pluginId);
    if (
      operatorManagedPluginIds.has(pluginId) ||
      !bundled ||
      !recordMatchesBundledPackage(record, bundled)
    ) {
      continue;
    }
    if (bundled.preserveExternalInstallRecord) {
      const message = formatSourceBundledPluginNotice(pluginId);
      notices.push(message);
      sourceOutcomes.push({
        pluginId,
        status: "unchanged",
        code: "source-bundled-plugin",
        message,
      });
      continue;
    }
    if (nextRecords === records) {
      nextRecords = { ...records };
    }
    delete nextRecords[pluginId];
    changes.push(`Removed stale managed install record for bundled plugin "${pluginId}".`);
  }

  for (const pluginId of stalePathInstallPluginIds) {
    changes.push(
      `Removed stale path-install record for plugin "${pluginId}" (loaded from a configured load path).`,
    );
  }

  if (shouldDeferConfiguredPluginInstallRepair(env)) {
    const updateDeferredPluginIds = collectUpdateDeferredPluginIds({
      cfg: params.cfg,
      env,
      configuredPluginIds: params.pluginIds,
      configuredChannelIds: params.channelIds,
      configuredChannelOwnerPluginIds,
      blockedPluginIds: params.blockedPluginIds,
    });
    for (const pluginId of updateDeferredPluginIds) {
      if (operatorManagedPluginIds.has(pluginId)) {
        continue;
      }
      deferredPluginIds.add(pluginId);
      const record = nextRecords[pluginId];
      if (
        !record ||
        (!isPayloadMissing(env, record.installPath) &&
          !installedPluginMissingRequiredDependencies.has(pluginId))
      ) {
        continue;
      }
      const detail = `Skipped package-manager repair for configured plugin "${pluginId}" during package update; rerun "openclaw doctor --fix" after the update completes.`;
      changes.push(detail);
      deferredRepairDetails.push(detail);
    }
  }

  const missingRecordedPlugins = Object.entries(records).filter(
    ([pluginId]) =>
      !operatorManagedPluginIds.has(pluginId) &&
      !deferredPluginIds.has(pluginId) &&
      !officialReplacementPluginIds.has(pluginId) &&
      Object.hasOwn(nextRecords, pluginId) &&
      !bundledPluginsById.has(pluginId) &&
      ((params.pluginIds.has(pluginId) &&
        (!knownIds.has(pluginId) || isPayloadMissing(env, nextRecords[pluginId]?.installPath))) ||
        configuredPluginIdsWithStaleDescriptors.has(pluginId) ||
        installedPluginIdsWithRepairablePackages.has(pluginId) ||
        driftedPluginIds.has(pluginId)),
  );
  const missingRecordedPluginIds = missingRecordedPlugins.map(([pluginId]) => pluginId);

  if (missingRecordedPluginIds.length > 0) {
    // Dropping resolved fields forces an installer attempt, not a record mutation.
    const repairRecords = { ...nextRecords };
    for (const [pluginId, record] of missingRecordedPlugins) {
      const missingDependencies = installedPluginMissingRequiredDependencies.get(pluginId);
      if (
        missingDependencies ||
        (!installedPluginIdsWithStaleVersionBoundRuntimePackages.has(pluginId) &&
          !driftedPluginIds.has(pluginId)) ||
        installedPluginIdsWithRepairablePackageDiagnostics.has(pluginId) ||
        configuredPluginIdsWithStaleDescriptors.has(pluginId) ||
        isPayloadMissing(env, record.installPath)
      ) {
        repairRecords[pluginId] = forceNpmInstallRecordRepair(record);
      }
      if (missingDependencies) {
        await params.beforePersistentEffect?.();
        assertCurrent();
        if (!hasRetainedManagedNpmInstallMarker(missingDependencies.rootDir)) {
          // Track before writing so partial marker writes are recovered by this owner.
          dependencyRepairMarkers.set(pluginId, missingDependencies.rootDir);
          await markRetainedManagedNpmInstall({
            packageDir: missingDependencies.rootDir,
            pluginId,
            reason: "doctor-missing-required-dependencies",
            assertCurrent,
          });
        }
      }
    }
    const updateResult = await updateNpmInstalledPlugins(
      copyPluginInstallTransactionRequest(params, {
        config: {
          ...params.cfg,
          plugins: {
            ...params.cfg.plugins,
            installs: repairRecords,
          },
        },
        pluginIds: missingRecordedPluginIds,
        timeoutMs: params.timeoutMs,
        workTimeoutMs: params.workTimeoutMs,
        npmInstallSpecOverrides: Object.fromEntries(
          Object.entries(cohortSpecs).filter(
            ([pluginId]) => driftedPluginIds.has(pluginId) && !newerRecordedPluginIds.has(pluginId),
          ),
        ),
        versionBoundPluginIds: new Set(
          missingRecordedPlugins
            .filter(
              ([pluginId, record]) =>
                (updateChannel === "stable" || updateChannel === "extended-stable") &&
                params.pluginIds.has(pluginId) &&
                VERSION_BOUND_RUNTIME_PLUGIN_IDS.has(pluginId) &&
                record.source === "npm" &&
                Boolean(cohortSpecs[pluginId]) &&
                !newerRecordedPluginIds.has(pluginId) &&
                (installedPluginIdsWithStaleVersionBoundRuntimePackages.has(pluginId) ||
                  isPayloadMissing(env, record.installPath)),
            )
            .map(([pluginId]) => pluginId),
        ),
        retainOnUnavailable: true,
        skipDisabledPlugins: true,
        updateChannel,
        coreVersion,
        logger: {
          terminalLinks: false,
          warn: (message) => {
            if (isClawHubReviewNotice(message)) {
              notices.push(stripAnsi(message));
              return;
            }
            warn(message);
          },
          error: (message) => warn(message),
        },
        ...(params.onCapabilityConsent ? { onCapabilityConsent: params.onCapabilityConsent } : {}),
        beforePersistentEffect: params.beforePersistentEffect,
      }),
    );
    for (const outcome of updateResult.outcomes) {
      if (outcome.status === "unchanged" && outcome.code === "plugin-target-unavailable") {
        recordFailure(outcome.pluginId, [outcome.message], outcome.code);
        continue;
      }
      if (
        outcome.status === "unchanged" &&
        updateResult.config.plugins?.installs?.[outcome.pluginId] ===
          repairRecords[outcome.pluginId]
      ) {
        notices.push(outcome.message);
      } else if (outcome.status === "updated" || outcome.status === "unchanged") {
        repairedPluginIds.add(outcome.pluginId);
        failedPlugins.delete(outcome.pluginId);
        changes.push(
          installedPluginMissingRequiredDependencies.has(outcome.pluginId)
            ? `Repaired missing dependencies for installed plugin "${outcome.pluginId}".`
            : driftedPluginIds.has(outcome.pluginId)
              ? `Updated official plugin "${outcome.pluginId}" from ${outcome.currentVersion ?? records[outcome.pluginId]?.version} to ${outcome.nextVersion ?? coreVersion}.`
              : installedPluginIdsWithStaleVersionBoundRuntimePackages.has(outcome.pluginId)
                ? `Refreshed stale configured plugin "${outcome.pluginId}".`
                : installedPluginIdsWithRepairablePackageDiagnostics.has(outcome.pluginId)
                  ? `Repaired broken installed plugin "${outcome.pluginId}".`
                  : `Repaired missing configured plugin "${outcome.pluginId}".`,
        );
      } else if (
        outcome.status === "error" ||
        isClawHubTrustSkippedOutcome(outcome) ||
        (outcome.status === "skipped" &&
          installedPluginMissingRequiredDependencies.has(outcome.pluginId))
      ) {
        recordFailure(outcome.pluginId, [outcome.message], outcome.code);
      }
    }
    if (repairedPluginIds.size > 0) {
      nextRecords = { ...(updateResult.config.plugins?.installs ?? nextRecords) };
      for (const [pluginId, record] of missingRecordedPlugins) {
        if (!repairedPluginIds.has(pluginId)) {
          nextRecords[pluginId] = record;
        }
      }
    }
  }

  const missingPluginIds = new Set(
    [...params.pluginIds].filter((pluginId) => {
      if (operatorManagedPluginIds.has(pluginId) || deferredPluginIds.has(pluginId)) {
        return false;
      }
      const hasRecord = Object.hasOwn(nextRecords, pluginId);
      return (
        (!knownIds.has(pluginId) && !hasRecord && !bundledPluginsById.has(pluginId)) ||
        (hasRecord &&
          !bundledPluginsById.has(pluginId) &&
          isPayloadMissing(env, nextRecords[pluginId]?.installPath))
      );
    }),
  );
  const installCandidatePluginIds = new Set([...missingPluginIds, ...officialReplacementPluginIds]);
  for (const candidate of collectDownloadableInstallCandidates({
    cfg: params.cfg,
    env,
    missingPluginIds: installCandidatePluginIds,
    configuredPluginIds: params.pluginIds,
    configuredChannelIds: params.channelIds,
    configuredChannelOwnerPluginIds,
    blockedPluginIds: new Set([
      ...(params.blockedPluginIds ?? []),
      ...deferredPluginIds,
      ...operatorManagedPluginIds,
    ]),
  })) {
    const repair = resolveConfiguredPluginCandidateRepair({
      candidate,
      records: nextRecords,
      env,
      context: installContext,
    });
    if (!repair) {
      continue;
    }
    const { shouldReplaceBrokenOfficialInstall, repairReason } = repair;
    const record = nextRecords[candidate.pluginId];
    const removalPath = shouldReplaceBrokenOfficialInstall
      ? resolveSafeBrokenOfficialInstallRemovalPath({
          pluginId: candidate.pluginId,
          candidate,
          record,
          env,
        })
      : null;
    // Capture the old payload before replacement planning yields. Its pathname
    // can be reused before the index commits; cleanup must never adopt that replacement.
    const assertRemovalPath = removalPath ? capturePathRemovalGuard(removalPath) : undefined;
    const removalParent = removalPath ? path.dirname(removalPath) : undefined;
    const assertRemovalParent =
      assertRemovalPath && removalParent ? capturePathRemovalGuard(removalParent) : undefined;
    const removalParentReal =
      assertRemovalParent && removalParent ? realpathSync(removalParent) : undefined;
    const removalParentIdentity = removalParentReal
      ? lstatSync(removalParentReal, { bigint: true })
      : undefined;
    const previousRecords = nextRecords;
    const installed = await installCandidate(
      copyPluginInstallTransactionRequest(params, {
        candidate,
        config: params.cfg,
        timeoutMs: params.timeoutMs,
        workTimeoutMs: params.workTimeoutMs,
        records: nextRecords,
        env,
        updateChannel,
        mode: shouldReplaceBrokenOfficialInstall ? "update" : "install",
        repairReason,
        ...(params.onCapabilityConsent ? { onCapabilityConsent: params.onCapabilityConsent } : {}),
        beforePersistentEffect: params.beforePersistentEffect,
      }),
    );
    if (shouldReplaceBrokenOfficialInstall) {
      const installedRecord = installed.records[candidate.pluginId];
      const replacementSucceeded = installed.records !== previousRecords;
      if (
        replacementSucceeded &&
        removalPath &&
        assertRemovalPath &&
        removalParent &&
        assertRemovalParent &&
        removalParentReal &&
        removalParentIdentity &&
        (!installedRecord?.installPath ||
          !installPathsEqual(resolveUserPath(installedRecord.installPath, env), removalPath))
      ) {
        const assertRetirementOwned = retainMutationAuthority(() => {
          assertCurrent();
          // Operators may link the extensions root. Keep both that alias and
          // its canonical directory pinned so retirement cannot adopt a replacement.
          assertRemovalParent();
          if (realpathSync(removalParent) !== removalParentReal) {
            throw new FsSafeError("path-mismatch", "plugin retirement parent changed");
          }
          assertDirectoryIdentitySync(removalParentReal, {
            dev: removalParentIdentity.dev,
            ino: removalParentIdentity.ino,
            realPath: removalParentReal,
          });
          assertRemovalPath();
        });
        // The old path is outside the replacement transaction. Retire it only
        // after the index commits, so a failed write can roll back to the old payload.
        retainPluginInstallTransaction(
          params,
          attachPluginInstallTransaction(
            {},
            {
              commit: async () => {
                await params.beforePersistentEffect?.();
                // Planning may yield; authority refusal must not become a cleanup warning.
                assertRetirementOwned();
                try {
                  await removePathWithinRoot({
                    rootDir: removalParentReal,
                    relativePath: path.basename(removalPath),
                    recursive: true,
                    force: true,
                    symlinks: "unlink",
                    assertBeforeMutation: assertRetirementOwned,
                  });
                } catch (error) {
                  assertRetirementOwned();
                  if (!isRemovalIoError(error)) {
                    throw error;
                  }
                  warn(
                    `Failed to remove broken installed plugin "${candidate.pluginId}" at ${removalPath}: ${String(error)}`,
                  );
                }
              },
              rollback: async () => {},
            },
          ),
        );
      }
    }
    nextRecords = installed.records;
    changes.push(...installed.changes);
    notices.push(...installed.notices);
    if (
      !installed.failedPluginId &&
      installed.records !== previousRecords &&
      installed.records[candidate.pluginId]
    ) {
      repairedPluginIds.add(candidate.pluginId);
      failedPlugins.delete(candidate.pluginId);
    }
    if (installed.failedPluginId) {
      recordFailure(installed.failedPluginId, installed.warnings, installed.code);
    } else {
      for (const message of installed.warnings) {
        warn(message);
      }
    }
  }

  const persistedIndexOptions = { config: params.cfg, env, filePath: lease.databasePath, lease };
  // An explicit baseline may include earlier unpersisted sync/npm changes;
  // commit it even when this repair made no further changes.
  if (nextRecords !== persistedRecords || params.baselineRecords) {
    if (params.beforePersistentEffect) {
      const persistedIndex = readPersistedInstalledPluginIndexSync(persistedIndexOptions);
      // Republishing an unchanged baseline preserves the index contract without
      // starting a protected update or stopping a healthy Gateway.
      if (
        !persistedIndex ||
        hashStableJson(nextRecords) !== hashStableJson(persistedIndex.installRecords) ||
        persistedIndex.policyHash !== resolveInstalledPluginIndexPolicyHash(params.cfg, env)
      ) {
        await params.beforePersistentEffect();
      }
    }
    lease.assertOwned();
    await writePersistedInstalledPluginIndexInstallRecordsWithLease(
      nextRecords,
      persistedIndexOptions,
    );
  }
  const pluginInventoryChanged = nextRecords !== persistedRecords || repairedPluginIds.size > 0;
  if ([...driftedPluginIds].some((pluginId) => repairedPluginIds.has(pluginId))) {
    changes.push(
      `If the Gateway is not restarted by Doctor, run ${formatCliCommand("openclaw gateway restart", env)} to load the updated plugins.`,
    );
  }
  const outcomes = [
    ...sourceOutcomes,
    ...[...failedPlugins.values()].filter((outcome) => outcome !== undefined),
  ];
  return {
    changes,
    warnings,
    ...(outcomes.length > 0 ? { outcomes } : {}),
    ...(notices.length > 0 ? { notices } : {}),
    ...(deferredRepairDetails.length > 0 ? { deferredRepairDetails } : {}),
    ...(repairedPluginIds.size > 0
      ? {
          repairedPluginIds: [...repairedPluginIds].toSorted((left, right) =>
            left.localeCompare(right),
          ),
        }
      : {}),
    ...(pluginInventoryChanged ? { pluginInventoryChanged: true as const } : {}),
    ...(failedPlugins.size > 0
      ? {
          failedPluginIds: [...failedPlugins.keys()].toSorted((left, right) =>
            left.localeCompare(right),
          ),
        }
      : {}),
    records: nextRecords,
  };
}
