import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { coerceErrorMessage, stableStringify } from "@openclaw/normalization-core";
import { resolveClawHubInstallConfirmation } from "../cli/clawhub-install-confirmation.js";
import { resolvePluginCapabilityConsentCliOptions } from "../cli/plugin-capability-consent.js";
import { createPluginInstallLogger } from "../cli/plugins-command-helpers.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { installPluginFromClawHub } from "../plugins/clawhub.js";
import { PLUGIN_ARTIFACT_ADAPTER_IDENTITY } from "../plugins/install-artifact-inspection.js";
import { installManagedPlugin } from "../plugins/management-mutations.js";
import { uninstallPluginWithPolicy } from "../plugins/management-uninstall.js";
import {
  preflightPluginInstall,
  resolveInstalledClawHubPlugin,
} from "../plugins/plugin-install-preflight.js";
import { defaultRuntime } from "../runtime.js";
import { installSkillFromClawHub, preflightSkillFromClawHub } from "../skills/lifecycle/clawhub.js";
import type { ClawPackageLifecycleArtifact } from "../state/claw-package-lifecycle-lease-key.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import {
  findResumableIntroducedPluginRequirement,
  ownerInstallIsNewerThanRefs,
} from "./package-resume.js";
import { resolveClawPluginSetupRequirements } from "./package-setup-requirements.js";
import { runClawPluginBatch, type ClawPluginRuntimeOptions } from "./plugin-runtime.js";
import {
  persistClawPackageRef,
  readClawPackageRefs,
  updateClawPackageRefStatus,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type {
  ClawAddPlan,
  ClawAddPlanAction,
  ClawPackage,
  ClawPackagePreflightResult,
  ResolvedClawPackage,
} from "./types.js";

export class ClawPackageInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly installedPackages: PersistedClawPackageRef[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClawPackageInstallError";
  }
}

type PackageInstallerDeps = {
  installPlugin?: (params: Parameters<typeof installManagedPlugin>[0]) => Promise<void>;
  uninstallPlugin?: (params: Parameters<typeof uninstallPluginWithPolicy>[0]) => Promise<void>;
  probePlugin?: typeof installPluginFromClawHub;
  installSkill?: typeof installSkillFromClawHub;
  preflightPlugin?: typeof preflightPluginInstall;
  preflightSkill?: typeof preflightSkillFromClawHub;
  persistPackageRef?: typeof persistClawPackageRef;
  completePackageRef?: typeof updateClawPackageRefStatus;
  readPackageRefs?: typeof readClawPackageRefs;
  withPackageLease?: typeof withClawPackageLifecycleLease;
  resolvePlugin?: typeof resolveInstalledClawHubPlugin;
};

type PlannedClawPackage = ResolvedClawPackage & {
  ownerAction: "install" | "reuse";
  installId?: string;
  riskWarning?: string;
};
function packageFromAction(action: ClawAddPlanAction): PlannedClawPackage {
  const details = action.details as Partial<PlannedClawPackage> | undefined;
  if (details?.kind !== "skill" && details?.kind !== "plugin") {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no valid package kind.`);
  }
  if (
    details.source !== "clawhub" ||
    !details.ref ||
    !details.version ||
    !details.integrity ||
    !normalizeClawHubSha256Integrity(details.integrity)
  ) {
    throw new Error(
      `Package action ${JSON.stringify(action.id)} is not a pinned ClawHub package with integrity.`,
    );
  }
  if (details.ownerAction !== "install" && details.ownerAction !== "reuse") {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no planned owner state.`);
  }
  if (details.kind === "plugin" && !details.installId) {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no resolved plugin id.`);
  }
  return {
    kind: details.kind,
    source: details.source,
    ref: details.ref,
    version: details.version,
    integrity: details.integrity,
    ownerAction: details.ownerAction,
    ...(details.extension ? { extension: details.extension } : {}),
    ...(details.installId ? { installId: details.installId } : {}),
    ...(details.riskWarning ? { riskWarning: details.riskWarning } : {}),
  };
}

async function probeClawPluginArtifact(
  pkg: ClawPackage,
  isolateFromLiveExtensions: boolean,
  deps: Pick<PackageInstallerDeps, "probePlugin">,
): Promise<Awaited<ReturnType<typeof installPluginFromClawHub>>> {
  const probePlugin = deps.probePlugin ?? installPluginFromClawHub;
  const request = {
    spec: `clawhub:${pkg.ref}@${pkg.version}`,
    dryRun: true,
  } as const;
  if (!isolateFromLiveExtensions) {
    return await probePlugin(request);
  }
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-claw-plugin-probe-",
  });
  try {
    return await probePlugin({ ...request, extensionsDir: workspace.dir });
  } finally {
    // Temporary probe cleanup must not replace the canonical preflight result.
    await workspace.cleanup().catch(() => undefined);
  }
}

export async function preflightClawPackage(
  pkg: ClawPackage,
  workspaceDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    deps?: Pick<PackageInstallerDeps, "preflightPlugin" | "probePlugin">;
  } = {},
): Promise<ClawPackagePreflightResult> {
  if (pkg.kind === "skill") {
    const result = await preflightSkillFromClawHub({
      workspaceDir,
      slug: pkg.ref,
      version: pkg.version,
    });
    return result.ok ? result : { ok: false, code: result.code, message: result.error };
  }
  const result = await (options.deps?.preflightPlugin ?? preflightPluginInstall)({
    clawhubPackage: pkg.ref,
    rawSpec: `clawhub:${pkg.ref}@${pkg.version}`,
    expectedVersion: pkg.version,
  });
  if (!result.ok && result.code !== "plugin_version_conflict") {
    return {
      ok: false,
      code: result.code,
      message: result.error,
    };
  }
  const probe = await probeClawPluginArtifact(
    pkg,
    !(result.ok && result.action === "install"),
    options.deps ?? {},
  );
  if (!probe.ok) {
    return { ok: false, code: probe.code ?? "plugin_preflight_failed", message: probe.error };
  }
  if (!probe.artifactInspection) {
    return {
      ok: false,
      code: "plugin_artifact_inspection_unavailable",
      message: `Plugin ${pkg.ref}@${pkg.version} did not return canonical artifact inspection.`,
    };
  }
  if (probe.artifactInspection.format === "agent") {
    return {
      ok: false,
      code: "plugin_artifact_format_unsupported",
      message: `Plugin ${pkg.ref}@${pkg.version} uses unsupported Claw extension format agent.`,
    };
  }
  const integrity = probe.clawhub.integrity
    ? normalizeClawHubSha256Integrity(probe.clawhub.integrity)
    : null;
  if (!integrity) {
    return {
      ok: false,
      code: "plugin_integrity_unavailable",
      message: `Plugin ${pkg.ref}@${pkg.version} did not resolve an artifact integrity.`,
    };
  }
  const requirements = resolveClawPluginSetupRequirements({
    pluginId: probe.pluginId,
    setup: probe.setup,
    env: options.env ?? process.env,
  });
  const artifact = {
    integrity,
    installId: probe.pluginId,
    ...(requirements.length > 0 ? { requirements } : {}),
    detectedFormat: probe.artifactInspection.format,
    mapped: probe.artifactInspection.mapped,
    unavailable: probe.artifactInspection.unavailable,
    adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
    ...(probe.warning ? { warning: probe.warning } : {}),
  };
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      installedVersion: result.installedVersion,
      ...artifact,
      message: `Plugin ${pkg.ref}@${pkg.version} conflicts with installed version ${result.installedVersion}.`,
    };
  }
  if (
    result.action === "reuse" &&
    (result.installedId !== probe.pluginId ||
      !result.installedIntegrity ||
      normalizeClawHubSha256Integrity(result.installedIntegrity) !== integrity)
  ) {
    return {
      ok: false,
      code: "plugin_integrity_conflict",
      message: `Plugin ${pkg.ref}@${pkg.version} is installed as ${result.installedId} with integrity ${result.installedIntegrity ?? "unknown"}, expected ${probe.pluginId} with ${integrity}.`,
    };
  }
  return {
    ok: true,
    action: result.action,
    ...artifact,
    ...(result.action === "reuse" && result.installedIntegrity
      ? { installedIntegrity: result.installedIntegrity }
      : {}),
    ...(result.action === "reuse" && result.installedAt ? { installedAt: result.installedAt } : {}),
  };
}

type InstallClawPackagesOptions = ClawPluginRuntimeOptions & {
  deps?: PackageInstallerDeps;
  pluginInstallMode?: "install" | "update";
  nowMs?: number;
  onExternalMutation?: (pkg: ClawPackage) => void;
};

export async function installClawPackages(
  plan: ClawAddPlan,
  options: InstallClawPackagesOptions = {},
): Promise<PersistedClawPackageRef[]> {
  const pluginCount = plan.actions.filter(
    (action) => action.kind === "package" && action.details?.kind === "plugin",
  ).length;
  if (!pluginCount) {
    return await installClawPackagesUnlocked(plan, options);
  }
  return await runClawPluginBatch(
    options,
    pluginCount,
    (runtimeBatch) => installClawPackagesUnlocked(plan, { ...options, runtimeBatch }),
    (failure, operation) => {
      const original =
        !operation.ok && operation.error instanceof ClawPackageInstallError
          ? operation.error
          : undefined;
      return new ClawPackageInstallError(
        original?.code ?? "package_runtime_failed",
        [original?.message, coerceErrorMessage(failure)].filter(Boolean).join("\n"),
        original?.installedPackages ?? (operation.ok ? operation.value : []),
        { cause: !operation.ok ? new AggregateError([operation.error, failure]) : failure },
      );
    },
  );
}

async function installClawPackagesUnlocked(
  plan: ClawAddPlan,
  options: InstallClawPackagesOptions,
): Promise<PersistedClawPackageRef[]> {
  const deps = options.deps ?? {};
  const runtime = options.runtime ?? defaultRuntime;
  const installPlugin =
    deps.installPlugin ??
    (async (params) => {
      const result = await installManagedPlugin(params);
      for (const warning of result.warnings ?? []) {
        runtime.log(warning);
      }
      runtime.log(`Installed plugin requirement: ${result.plugin.id}`);
      if (!params.deferRuntime && !params.applyRuntime) {
        runtime.log("Restart the gateway to load plugins.");
      }
    });
  const uninstallPlugin =
    deps.uninstallPlugin ??
    (async (params) => {
      const result = await uninstallPluginWithPolicy(params);
      if (!result.ok) {
        throw new Error(result.error);
      }
      runtime.log(`Rolled back plugin requirement: ${result.value.pluginId}`);
    });
  const installSkill = deps.installSkill ?? installSkillFromClawHub;
  const preflightPlugin = deps.preflightPlugin ?? preflightPluginInstall;
  const preflightSkill = deps.preflightSkill ?? preflightSkillFromClawHub;
  const persistPackageRef = deps.persistPackageRef ?? persistClawPackageRef;
  const completePackageRef = deps.completePackageRef ?? updateClawPackageRefStatus;
  const readPackageRefs = deps.readPackageRefs ?? readClawPackageRefs;
  const withPackageLease = deps.withPackageLease ?? withClawPackageLifecycleLease;
  const resolvePlugin = deps.resolvePlugin ?? resolveInstalledClawHubPlugin;
  const installedPackages: PersistedClawPackageRef[] = [];
  const installedPlugins: Array<{ installId: string; packageIndex: number }> = [];

  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    try {
      const pkg = packageFromAction(action);
      const leaseArtifact: ClawPackageLifecycleArtifact =
        pkg.kind === "plugin"
          ? { kind: pkg.kind, source: pkg.source, ref: pkg.ref }
          : {
              kind: pkg.kind,
              source: pkg.source,
              ref: pkg.ref,
              workspace: plan.agent.workspace,
            };
      await withPackageLease(
        leaseArtifact,
        async (packageLease) => {
          if (pkg.kind === "skill") {
            const preflight = await preflightSkill({
              workspaceDir: plan.agent.workspace,
              slug: pkg.ref,
              version: pkg.version,
              expectedIntegrity: pkg.integrity,
            });
            packageLease.assertOwned();
            if (!preflight.ok) {
              throw new Error(preflight.error);
            }
            if (
              preflight.action !== pkg.ownerAction ||
              preflight.warning !== pkg.riskWarning ||
              normalizeClawHubSha256Integrity(preflight.integrity) !==
                normalizeClawHubSha256Integrity(pkg.integrity)
            ) {
              throw new ClawPackageInstallError(
                "package_owner_state_changed",
                `Skill ${pkg.ref}@${pkg.version} changed after planning; run add --dry-run again.`,
                installedPackages,
              );
            }
            if (preflight.action === "reuse") {
              installedPackages.push(
                persistPackageRef(plan, pkg, {
                  ...options,
                  status: "complete",
                  relationship: "managed",
                  origin: "pre-existing",
                  independentOwner: true,
                }),
              );
              return;
            }
            let packageRef = persistPackageRef(plan, pkg, {
              ...options,
              status: "pending",
              relationship: "managed",
              origin: "claw-introduced",
              independentOwner: false,
            });
            installedPackages.push(packageRef);
            // The installer has no mutation receipt. Mark the boundary before calling it so a throw
            // after an on-disk change is treated as uncertain instead of falsely reported as rolled back.
            options.onExternalMutation?.(pkg);
            const installed = await installSkill({
              workspaceDir: plan.agent.workspace,
              slug: pkg.ref,
              version: pkg.version,
              expectedIntegrity: pkg.integrity,
              clawManaged: true,
            });
            packageLease.assertOwned();
            if (!installed.ok) {
              throw new Error(installed.error);
            }
            packageRef = completePackageRef(packageRef, "complete", options);
            installedPackages[installedPackages.length - 1] = packageRef;
            return;
          }

          const preflight = await preflightPlugin({
            clawhubPackage: pkg.ref,
            rawSpec: `clawhub:${pkg.ref}@${pkg.version}`,
            expectedVersion: pkg.version,
          });
          packageLease.assertOwned();
          if (!preflight.ok) {
            throw new Error(
              preflight.code === "plugin_version_conflict"
                ? `Plugin ${pkg.ref}@${pkg.version} conflicts with installed version ${preflight.installedVersion}.`
                : preflight.error,
            );
          }
          const resumableRequirement =
            pkg.ownerAction === "install" && preflight.action === "reuse"
              ? findResumableIntroducedPluginRequirement({
                  agentId: plan.agent.finalId,
                  pkg,
                  preflight,
                  expectedIntegrity: pkg.integrity,
                  refs: readPackageRefs({
                    ...options,
                    agentId: plan.agent.finalId,
                    kind: pkg.kind,
                    source: pkg.source,
                    ref: pkg.ref,
                    version: pkg.version,
                  }),
                })
              : undefined;
          if (preflight.action !== pkg.ownerAction && !resumableRequirement) {
            throw new ClawPackageInstallError(
              "package_owner_state_changed",
              `Plugin ${pkg.ref}@${pkg.version} owner state changed from ${pkg.ownerAction} to ${preflight.action}; run add --dry-run again.`,
              installedPackages,
            );
          }
          const probe = await probeClawPluginArtifact(pkg, true, {
            probePlugin: deps.probePlugin,
          });
          packageLease.assertOwned();
          if (!probe.ok) {
            throw new Error(probe.error);
          }
          const probeIntegrity = probe.clawhub.integrity
            ? normalizeClawHubSha256Integrity(probe.clawhub.integrity)
            : null;
          const plannedExtensionInspection = pkg.extension
            ? {
                detectedFormat: pkg.extension.detectedFormat,
                mapped: pkg.extension.mapped,
                unavailable: pkg.extension.unavailable,
                adapterIdentity: pkg.extension.adapterIdentity,
              }
            : undefined;
          const probedExtensionInspection = probe.artifactInspection
            ? {
                detectedFormat: probe.artifactInspection.format,
                mapped: probe.artifactInspection.mapped,
                unavailable: probe.artifactInspection.unavailable,
                adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
              }
            : undefined;
          if (
            probe.pluginId !== pkg.installId ||
            probeIntegrity !== normalizeClawHubSha256Integrity(pkg.integrity) ||
            probe.warning !== pkg.riskWarning ||
            (plannedExtensionInspection &&
              stableStringify(probedExtensionInspection) !==
                stableStringify(plannedExtensionInspection))
          ) {
            throw new ClawPackageInstallError(
              "package_owner_state_changed",
              `Plugin ${pkg.ref}@${pkg.version} identity or trust state changed after planning; run add --dry-run again.`,
              installedPackages,
            );
          }
          if (preflight.action === "reuse") {
            if (
              preflight.installedId !== pkg.installId ||
              !preflight.installedIntegrity ||
              normalizeClawHubSha256Integrity(preflight.installedIntegrity) !==
                normalizeClawHubSha256Integrity(pkg.integrity)
            ) {
              throw new ClawPackageInstallError(
                "package_owner_state_changed",
                `Plugin ${pkg.ref}@${pkg.version} identity changed after planning; run add --dry-run again.`,
                installedPackages,
              );
            }
            if (resumableRequirement) {
              options.runtimeBatch?.retain(probe.pluginId);
              installedPackages.push(
                persistPackageRef(plan, pkg, {
                  ...options,
                  status: "complete",
                  relationship: resumableRequirement.relationship,
                  origin: resumableRequirement.origin,
                  independentOwner: resumableRequirement.independentOwner,
                }),
              );
              return;
            }
            const existingRefs = readPackageRefs({
              ...options,
              kind: pkg.kind,
              source: pkg.source,
              ref: pkg.ref,
              version: pkg.version,
            });
            const inheritsClawOrigin =
              existingRefs.length > 0 &&
              existingRefs.every(
                (candidate) =>
                  candidate.origin === "claw-introduced" && !candidate.independentOwner,
              ) &&
              !ownerInstallIsNewerThanRefs(preflight.installedAt, existingRefs);
            installedPackages.push(
              persistPackageRef(plan, pkg, {
                ...options,
                status: "complete",
                relationship: "referenced",
                origin: inheritsClawOrigin ? "claw-introduced" : "pre-existing",
                independentOwner: !inheritsClawOrigin,
              }),
            );
            return;
          }

          let packageRef = persistPackageRef(plan, pkg, {
            ...options,
            status: "pending",
            relationship: "referenced",
            origin: "claw-introduced",
            independentOwner: false,
          });
          installedPackages.push(packageRef);

          // The installer has no mutation receipt. Mark the boundary before calling it so a throw
          // after an on-disk change is treated as uncertain instead of falsely reported as rolled back.
          options.onExternalMutation?.(pkg);
          await installPlugin({
            request: {
              source: "clawhub",
              packageName: pkg.ref,
              version: pkg.version,
              mode: options.pluginInstallMode ?? "install",
              expectedIntegrity: pkg.integrity,
              expectedPluginId: probe.pluginId,
            },
            env: options.env,
            beforePersistentApply: () => packageLease.assertOwned(),
            logger: createPluginInstallLogger(runtime),
            confirmInstall: resolveClawHubInstallConfirmation(),
            ...resolvePluginCapabilityConsentCliOptions({ action: "install", runtime }),
            invalidateRuntimeCache: false,
            clawManaged: true,
            deferRuntime: options.runtimeBatch?.install(),
          });
          // A committed upgrade cannot restore its previous payload; retain it for reconciliation.
          if (options.pluginInstallMode !== "update") {
            installedPlugins.push({
              installId: probe.pluginId,
              packageIndex: installedPackages.length - 1,
            });
          }
          packageLease.assertOwned();
          packageRef = completePackageRef(packageRef, "complete", options);
          installedPackages[installedPackages.length - 1] = packageRef;
        },
        options,
      );
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      const pending = installedPackages.at(-1);
      if (pending?.status === "pending") {
        try {
          installedPackages[installedPackages.length - 1] = completePackageRef(
            pending,
            "failed",
            options,
          );
        } catch {
          // Preserve the installer error; pending provenance still exposes uncertain ownership.
        }
      }
      const rollbackErrors: string[] = [];
      for (const installedPlugin of installedPlugins.toReversed()) {
        const packageRef = installedPackages[installedPlugin.packageIndex];
        if (!packageRef) {
          continue;
        }
        try {
          await withPackageLease(
            { kind: "plugin", source: "clawhub", ref: packageRef.ref },
            async (rollbackLease) => {
              const sharedRefs = readPackageRefs({
                ...options,
                kind: "plugin",
                source: "clawhub",
                ref: packageRef.ref,
                version: packageRef.version,
                integrity: packageRef.integrity,
              }).filter(
                (ref) =>
                  ref.agentId !== plan.agent.finalId &&
                  (ref.status === "pending" || ref.status === "complete"),
              );
              if (sharedRefs.length > 0) {
                rollbackErrors.push(
                  `kept plugin ${installedPlugin.installId} because another Claw now references it`,
                );
                return;
              }
              const currentRefs = readPackageRefs({
                ...options,
                kind: "plugin",
                source: "clawhub",
                ref: packageRef.ref,
                version: packageRef.version,
              });
              if (currentRefs.some((candidate) => candidate.independentOwner)) {
                rollbackErrors.push(
                  `kept plugin ${installedPlugin.installId} because it now has a direct owner`,
                );
                return;
              }
              const installed = await resolvePlugin({ clawhubPackage: packageRef.ref });
              const installedIntegrity =
                installed.status === "found" && installed.record.integrity
                  ? normalizeClawHubSha256Integrity(installed.record.integrity)
                  : null;
              if (
                installed.status !== "found" ||
                installed.pluginId !== installedPlugin.installId ||
                installed.installedVersion !== packageRef.version ||
                installedIntegrity !== normalizeClawHubSha256Integrity(packageRef.integrity) ||
                ownerInstallIsNewerThanRefs(installed.record.installedAt, currentRefs)
              ) {
                rollbackErrors.push(
                  `kept plugin ${installedPlugin.installId} because its installed identity changed after Claw installation`,
                );
                return;
              }
              await uninstallPlugin({
                pluginId: installedPlugin.installId,
                caller: "cli",
                invalidateRuntimeCache: false,
                clawManaged: true,
                beforePersistentApply: () => rollbackLease.assertOwned(),
                onWarning: (warning) => runtime.log(warning),
                deferRuntime: options.runtimeBatch?.install(),
              });
              rollbackLease.assertOwned();
              installedPackages[installedPlugin.packageIndex] = completePackageRef(
                installedPackages[installedPlugin.packageIndex] ?? packageRef,
                "rolled_back",
                options,
              );
            },
            options,
          );
        } catch (rollbackError) {
          if (hasSqliteWorkerOutcomeUnknown(rollbackError)) {
            throw rollbackError;
          }
          rollbackErrors.push(
            `could not remove plugin ${installedPlugin.installId}: ${coerceErrorMessage(rollbackError)}`,
          );
        }
      }
      const message = coerceErrorMessage(error);
      if (rollbackErrors.length > 0) {
        throw new ClawPackageInstallError(
          "package_rollback_failed",
          `${message} Rollback incomplete: ${rollbackErrors.join("; ")}.`,
          installedPackages,
          { cause: error },
        );
      }
      throw new ClawPackageInstallError(
        error instanceof ClawPackageInstallError ? error.code : "package_install_failed",
        message,
        installedPackages,
        { cause: error },
      );
    }
  }

  return installedPackages;
}
