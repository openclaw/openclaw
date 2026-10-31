// Reconciles configured plugin installs after the core package update has completed.
import path from "node:path";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { filterRecordsToActive } from "../../../plugins/active-payload-verification.js";
import type { PluginCapabilityConsentHandler } from "../../../plugins/capability-consent.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir,
} from "../../../plugins/install-paths.js";
import { listManagedPluginNpmRootsForInstallRecords } from "../../../plugins/installed-plugin-npm-roots.js";
import {
  runPluginPayloadSmokeCheck,
  type PluginPayloadSmokeFailure,
} from "../../../plugins/payload-verification.js";
import { withPluginLifecycleLease } from "../../../plugins/plugin-lifecycle-lease.js";
import { repairInstalledOpenClawHostLinks } from "../../../plugins/plugin-peer-link.js";
import { detectPluginVersionDrift } from "../../../plugins/plugin-version-drift.js";
import { pruneStaleLocalBundledPluginInstallRecords } from "../../../plugins/stale-local-bundled-plugin-install-records.js";
import type { PluginUpdateOutcome } from "../../../plugins/update.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveCompatibilityHostVersion } from "../../../version.js";
// Link mandatory repairs before a package swap can remove this updater's old chunks.
import { maybeRepairStaleManagedNpmBundledPlugins } from "../../doctor-plugin-registry.js";
import {
  recoverInstalledPluginConfigIds,
  type InstalledPluginIdRecovery,
} from "./installed-plugin-id-recovery.js";
import { repairMissingConfiguredPluginInstalls } from "./missing-configured-plugin-install.js";
import { isPostCoreConvergencePass, resolvePostCoreConvergenceEnv } from "./update-phase.js";

type PostCoreConvergenceWarning = {
  kind?: "load" | "repair";
  pluginId?: string;
  reason: string;
  message: string;
  guidance: string[];
};

type PostCoreConvergenceResult = {
  config: OpenClawConfig;
  configChanges: string[];
  installedPluginIdRecovery: InstalledPluginIdRecovery;
  changes: string[];
  notices?: PostCoreConvergenceWarning[];
  warnings: PostCoreConvergenceWarning[];
  outcomes?: PluginUpdateOutcome[];
  repairedPluginIds?: string[];
  errored: boolean;
  smokeFailures: PluginPayloadSmokeFailure[];
  /** Persisted baseline plus repairs; subsequent commits must use this map to avoid lost updates. */
  installRecords: Record<string, PluginInstallRecord>;
};

const REPAIR_GUIDANCE = "Run `openclaw update repair` to retry plugin repair.";
const inspectGuidance = (pluginId: string) =>
  `Run \`openclaw plugins inspect ${pluginId} --runtime --json\` for details.`;

function convergenceNotice(message: string, guidance: string[]): PostCoreConvergenceWarning {
  return { reason: message, message, guidance };
}

function smokeFailureGuidance(failure: PluginPayloadSmokeFailure): string[] {
  if (failure.reason !== "unreadable-package-json") {
    return [REPAIR_GUIDANCE, inspectGuidance(failure.pluginId)];
  }
  const packageJsonPath = failure.installPath
    ? path.join(failure.installPath, "package.json")
    : "the plugin package.json";
  return [
    `Fix file access for ${packageJsonPath} so it is readable by the user running OpenClaw. For EACCES or EPERM, correct its ownership or permissions; otherwise resolve the reported filesystem I/O error, then retry.`,
    inspectGuidance(failure.pluginId),
  ];
}

function formatPeerLinkPackageReadWarning(failure: { error: unknown }): PostCoreConvergenceWarning {
  const message = `Failed to repair installed OpenClaw host peer links: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`;
  return convergenceNotice(message, [REPAIR_GUIDANCE]);
}

/**
 * Mandatory post-core convergence pass. Runs AFTER the core package files
 * are swapped and the in-update doctor pass has already returned, but BEFORE
 * the gateway is restarted. Transient repair fetch failures stay nonblocking;
 * consent that prevents activation and payload smoke failures are errors.
 * Gateway startup quarantines known payload failures before any module import,
 * then boots with those plugins marked configured-unavailable.
 */
export async function runPostCorePluginConvergence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  compatibilityHostVersion?: string;
  timeoutMs?: number;
  workTimeoutMs?: number | null;
  /**
   * Optional in-memory install records from earlier post-core steps (e.g.
   * `syncPluginsForUpdateChannel`, `updateNpmInstalledPlugins`) whose
   * mutations have not been persisted to the installed-plugin index yet.
   * When provided, repair layers its mutations on top of these records
   * instead of reading the stale pre-update disk snapshot, and the merged
   * map is what gets persisted and returned via `installRecords`.
   */
  baselineInstallRecords?: Record<string, PluginInstallRecord>;
  /** Only a config-writing caller may plan recovery before smoke-checking that candidate. */
  configPersistence?: "caller";
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  beforePersistentEffect?: () => void;
}): Promise<PostCoreConvergenceResult> {
  return await withPluginLifecycleLease(
    { env: params.env, assertCurrent: params.beforePersistentEffect },
    (lease) =>
      runPostCorePluginConvergenceWithLease({
        ...params,
        beforePersistentEffect: () => lease.assertOwned(),
      }),
  );
}

async function runPostCorePluginConvergenceWithLease(
  params: Parameters<typeof runPostCorePluginConvergence>[0],
): Promise<PostCoreConvergenceResult> {
  const env = resolvePostCoreConvergenceEnv(params.env, params.compatibilityHostVersion);
  const repairVersionDrift = isPostCoreConvergencePass(params.env);
  // Retire obsolete managed shadows before relinking or smoke-checking them. A package that
  // became bundled with the new core must not survive into the next startup's contract graph.
  params.beforePersistentEffect?.();
  const staleManagedNpmBundledPluginRepair = maybeRepairStaleManagedNpmBundledPlugins({
    config: params.cfg,
    env,
    prompter: { shouldRepair: true },
    ...(params.baselineInstallRecords ? { installRecords: params.baselineInstallRecords } : {}),
  });
  const convergenceBaseline =
    staleManagedNpmBundledPluginRepair?.installRecords ?? params.baselineInstallRecords;
  const prunedBaseline = convergenceBaseline
    ? pruneStaleLocalBundledPluginInstallRecords({
        installRecords: convergenceBaseline,
        env,
      })
    : null;

  const warnings: PostCoreConvergenceWarning[] = [];
  const repair = await repairMissingConfiguredPluginInstalls({
    cfg: params.cfg,
    // App-owned activation reaches this pass before plugin migrations, without CLI cohort sync.
    repairVersionDrift,
    timeoutMs: params.timeoutMs,
    workTimeoutMs: params.workTimeoutMs,
    env,
    ...(prunedBaseline ? { baselineRecords: prunedBaseline.records } : {}),
    onCapabilityConsent: params.onCapabilityConsent,
    onWarning: ({ message, pluginId }) => {
      warnings.push({
        ...(pluginId ? { kind: "repair", pluginId } : {}),
        reason: message,
        message,
        guidance: [REPAIR_GUIDANCE],
      });
    },
    beforePersistentEffect: params.beforePersistentEffect,
  });
  params.beforePersistentEffect?.();

  const hostLinkInstallRecords = repair.records;
  const hostLinkBeforeEffect = params.beforePersistentEffect;
  let peerLinkChanges: string[] = [];
  let peerLinkWarnings: PostCoreConvergenceWarning[] = [];
  const peerLinkPackageReadFailures: Array<{ error: unknown; packageDir: string }> = [];
  let effectFailure: { error: unknown } | undefined;
  const beforePersistentEffect = hostLinkBeforeEffect
    ? () => {
        if (effectFailure) {
          throw effectFailure.error;
        }
        try {
          hostLinkBeforeEffect?.();
        } catch (error) {
          effectFailure ??= { error };
          throw effectFailure.error;
        }
      }
    : undefined;
  const onPackageReadError = (error: unknown, packageDir: string) => {
    peerLinkPackageReadFailures.push({ error, packageDir });
  };
  try {
    const npmRoots = listManagedPluginNpmRootsForInstallRecords({
      npmRoot: resolveDefaultPluginNpmDir(env),
      installRecords: hostLinkInstallRecords,
      env,
    });
    const { managedRepaired, registeredRepaired } = await repairInstalledOpenClawHostLinks({
      managedNpmRoots: npmRoots,
      installRecords: hostLinkInstallRecords,
      extensionsDir: resolveDefaultPluginExtensionsDir(env),
      env,
      beforePersistentApply: beforePersistentEffect,
      logger: {},
      onPackageReadError,
    });
    if (effectFailure) {
      throw effectFailure.error;
    }
    peerLinkChanges = [
      ...(managedRepaired > 0
        ? [
            `Repaired OpenClaw host peer link(s) for ${managedRepaired} managed npm plugin package(s).`,
          ]
        : []),
      ...(registeredRepaired > 0
        ? [
            `Repaired OpenClaw host peer link(s) for ${registeredRepaired} registered plugin package(s).`,
          ]
        : []),
    ];
  } catch (err) {
    if (effectFailure) {
      throw effectFailure.error;
    }
    beforePersistentEffect?.();
    peerLinkWarnings = [formatPeerLinkPackageReadWarning({ error: err })];
  }
  params.beforePersistentEffect?.();
  warnings.push(...peerLinkWarnings);
  const notices = (repair.notices ?? []).map((message) => convergenceNotice(message, []));

  const records: Record<string, PluginInstallRecord> = repair.records;
  const recovered =
    params.configPersistence === "caller"
      ? await recoverInstalledPluginConfigIds(params.cfg, env)
      : { config: params.cfg, changes: [], notices: [], recovery: new Map() };
  params.beforePersistentEffect?.();
  notices.push(
    ...recovered.notices.map((message) => convergenceNotice(message, [REPAIR_GUIDANCE])),
  );
  // Filter the smoke-check input to active records ONLY: configured /
  // enabled plugins, plus trusted-source-linked official sync targets
  // selected by `filterRecordsToActive`. Without this filter, a stale install
  // record for an inactive plugin could block the update even though the
  // gateway will never load it.
  const smokeRecords = filterRecordsToActive({ cfg: recovered.config, records, env });
  const smoke = await runPluginPayloadSmokeCheck({ records: smokeRecords, env });
  if (repairVersionDrift) {
    for (const drift of detectPluginVersionDrift({
      gatewayVersion: resolveCompatibilityHostVersion(env),
      installRecords: smokeRecords,
      config: recovered.config,
    }).drifts) {
      if (drift.source !== "npm") {
        continue;
      }
      warnings.push({
        kind: "repair",
        pluginId: drift.pluginId,
        reason: "plugin-version-mismatch",
        message: `Plugin "${drift.pluginId}" remains at ${drift.installedVersion} after the core update to ${drift.gatewayVersion}.`,
        guidance: [REPAIR_GUIDANCE],
      });
    }
  }
  const resolveInstallRecordPaths = (
    installRecords: Record<string, PluginInstallRecord>,
  ): Set<string> =>
    new Set(
      Object.values(installRecords).flatMap((record) => {
        const installPath = record.installPath?.trim();
        return installPath ? [path.resolve(resolveUserPath(installPath, env))] : [];
      }),
    );
  const knownInstallPaths = resolveInstallRecordPaths(records);
  const activeInstallPaths = resolveInstallRecordPaths(smokeRecords);
  const smokeFailureInstallPaths = new Set(
    smoke.failures.flatMap((failure) =>
      failure.installPath ? [path.resolve(failure.installPath)] : [],
    ),
  );
  for (const failure of peerLinkPackageReadFailures.toSorted((left, right) =>
    left.packageDir.localeCompare(right.packageDir),
  )) {
    // A typed smoke failure owns this exact package and startup quarantines it.
    // Keep the typed diagnostic instead of duplicating it as an unowned warning.
    const packageDir = path.resolve(failure.packageDir);
    const hasTypedFailure = smokeFailureInstallPaths.has(packageDir);
    const belongsToInactivePlugin =
      knownInstallPaths.has(packageDir) && !activeInstallPaths.has(packageDir);
    if (!hasTypedFailure && !belongsToInactivePlugin) {
      warnings.push(formatPeerLinkPackageReadWarning(failure));
    }
  }
  for (const failure of smoke.failures) {
    warnings.push({
      kind: "load",
      pluginId: failure.pluginId,
      reason: `${failure.reason}: ${failure.detail}`,
      message: `Plugin "${failure.pluginId}" failed post-core payload smoke check (${failure.reason}): ${failure.detail}`,
      guidance: smokeFailureGuidance(failure),
    });
  }

  return {
    config: recovered.config,
    configChanges: recovered.changes,
    installedPluginIdRecovery: recovered.recovery,
    changes: [
      ...(staleManagedNpmBundledPluginRepair?.removedPluginIds.map(
        (pluginId) => `Removed stale managed install record for bundled plugin "${pluginId}".`,
      ) ?? []),
      ...(prunedBaseline?.stale.map(
        (record) => `Removed stale local bundled plugin install record "${record.pluginId}".`,
      ) ?? []),
      ...repair.changes,
      ...peerLinkChanges,
    ],
    notices,
    warnings,
    outcomes: repair.outcomes,
    ...(repair.repairedPluginIds?.length ? { repairedPluginIds: repair.repairedPluginIds } : {}),
    errored:
      repair.outcomes?.some(
        (outcome) =>
          outcome.status === "error" && outcome.code === PLUGIN_CAPABILITY_CONSENT_REQUIRED,
      ) === true || smoke.failures.length > 0,
    smokeFailures: smoke.failures,
    installRecords: records,
  };
}
