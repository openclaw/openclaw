import { coerceErrorMessage, stableStringify } from "@openclaw/normalization-core";
import { createPluginInstallLogger } from "../cli/plugins-command-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import type { PackageDirInstallTransaction } from "../infra/install-package-dir.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
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
import type { ClawHubSkillUninstallPlan } from "../skills/lifecycle/workspace-types.js";
import {
  acquireClawPackageLifecycleLease,
  maintainClawPackageLifecycleLease,
  type MaintainedClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import {
  persistClawPackageRefForAdd,
  readClawPackageRefsForAdd,
  updateClawPackageRefStatusForAdd,
  type ClawAddStateOptions,
} from "./add-state-write.js";
import { packageFromAction, type PlannedClawPackage } from "./package-plan-action.js";
import { bindClawPluginBeforeCommit } from "./package-plugin-before-commit.js";
import {
  acquireMaintainedClawPackageLease,
  createClawPackageRefWriter,
  withClawPackageRefWrite,
} from "./package-ref-state-write.js";
import {
  findResumableIntroducedPluginRequirement,
  ownerInstallIsNewerThanRefs,
} from "./package-resume.js";
import {
  inspectClawPluginCapabilities,
  preflightClawPluginPackage,
  probeClawPluginArtifact,
  sourceHostPluginConflict,
  type ClawPluginProbeDeps,
} from "./plugin-capability-probe.js";
import { runClawPluginBatch, type ClawPluginRuntimeOptions } from "./plugin-runtime.js";
import {
  persistClawPackageRef,
  readClawPackageRefs,
  updateClawPackageRefStatus,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type { ClawAddPlan, ClawPackage, ClawPackagePreflightResult } from "./types.js";

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
  persistPackageRef?: (
    plan: Parameters<typeof persistClawPackageRef>[0],
    pkg: Parameters<typeof persistClawPackageRef>[1],
    options?: Parameters<typeof persistClawPackageRef>[2],
  ) => ReturnType<typeof persistClawPackageRef> | Promise<ReturnType<typeof persistClawPackageRef>>;
  completePackageRef?: (
    ref: Parameters<typeof updateClawPackageRefStatus>[0],
    status: Parameters<typeof updateClawPackageRefStatus>[1],
    options?: Parameters<typeof updateClawPackageRefStatus>[2],
  ) =>
    | ReturnType<typeof updateClawPackageRefStatus>
    | Promise<ReturnType<typeof updateClawPackageRefStatus>>;
  readPackageRefs?: (
    options?: Parameters<typeof readClawPackageRefs>[0],
  ) => ReturnType<typeof readClawPackageRefs> | Promise<ReturnType<typeof readClawPackageRefs>>;
  acquirePackageLease?: typeof acquireClawPackageLifecycleLease;
  resolvePlugin?: typeof resolveInstalledClawHubPlugin;
  inspectPluginCapabilities?: typeof inspectClawPluginCapabilities;
};

export async function preflightClawPackage(
  pkg: ClawPackage,
  workspaceDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    config?: OpenClawConfig;
    deps?: Pick<PackageInstallerDeps, "preflightPlugin"> & ClawPluginProbeDeps;
  } = {},
): Promise<ClawPackagePreflightResult> {
  if (pkg.kind === "skill") {
    const result = await preflightSkillFromClawHub({
      workspaceDir,
      slug: pkg.ref,
      version: pkg.version,
    });
    return result.ok
      ? result
      : {
          ok: false,
          code: result.code,
          message: result.error,
          ...(result.integrity ? { integrity: result.integrity } : {}),
          ...(result.warning ? { warning: result.warning } : {}),
        };
  }
  return await preflightClawPluginPackage(pkg, options);
}

export type ClawPluginInstallConsent = {
  onCapabilityConsent: PluginCapabilityConsentHandler;
  confirmInstall?: (pluginId: string, warning?: string) => Promise<boolean>;
};

export type ClawSkillInstallConsent = {
  assertApproved: (
    pkg: Pick<PlannedClawPackage, "ref" | "version" | "integrity"> & { riskWarning: string },
  ) => void;
};

type InstallClawPackagesOptions = ClawPluginRuntimeOptions &
  ClawAddStateOptions & {
    config?: OpenClawConfig;
    clawHubBaseUrl?: string;
    pluginConsent?: ClawPluginInstallConsent;
    skillConsent?: ClawSkillInstallConsent;
    deps?: PackageInstallerDeps;
    pluginInstallMode?: "install" | "update";
    assertPluginOwnerCurrent?: () => Promise<void>;
    nowMs?: number;
    onExternalMutation?: (pkg: ClawPackage) => void;
    skillUpgrade?: {
      ref: string;
      plan: ClawHubSkillUninstallPlan;
      assertCurrent: () => Promise<void>;
    };
    onSkillTransaction?: (pkg: ClawPackage, transaction: PackageDirInstallTransaction) => void;
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
  const persistPackageRef = deps.persistPackageRef ?? persistClawPackageRefForAdd;
  const completePackageRef = deps.completePackageRef ?? updateClawPackageRefStatusForAdd;
  const readPackageRefs = deps.readPackageRefs ?? readClawPackageRefsForAdd;
  const acquirePackageLease = deps.acquirePackageLease ?? acquireClawPackageLifecycleLease;
  const resolvePlugin = deps.resolvePlugin ?? resolveInstalledClawHubPlugin;
  const installedPackages: PersistedClawPackageRef[] = [];
  const installedPlugins: Array<{ installId: string; packageIndex: number }> = [];

  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    let packageLease: MaintainedClawPackageLifecycleLease | null = null;
    try {
      const pkg = packageFromAction(action);
      packageLease = acquireMaintainedClawPackageLease(
        pkg,
        plan.agent.workspace,
        options,
        acquirePackageLease,
      );
      const activePackageLease = packageLease;
      const forwardWriter = createClawPackageRefWriter(
        activePackageLease,
        options,
        (refOptions, stateOptions) =>
          persistPackageRef(plan, pkg, { ...stateOptions, ...refOptions }),
        (ref, status, stateOptions) => completePackageRef(ref, status, stateOptions),
      );
      const { assertCurrent, assertForwardCurrent } = forwardWriter;
      const persistForwardPackageRef = forwardWriter.persist;
      const completeForwardPackageRef = forwardWriter.complete;
      if (pkg.kind === "skill") {
        const upgrade = options.skillUpgrade?.ref === pkg.ref ? options.skillUpgrade : undefined;
        if (upgrade) {
          if (!options.onSkillTransaction) {
            throw new Error("Skill upgrade transaction receiver is unavailable.");
          }
          await upgrade.assertCurrent();
        }
        const rawPreflight = await preflightSkill({
          workspaceDir: plan.agent.workspace,
          slug: pkg.ref,
          version: pkg.version,
          expectedIntegrity: pkg.integrity,
        });
        const preflight =
          upgrade &&
          !rawPreflight.ok &&
          rawPreflight.code === "skill_version_conflict" &&
          rawPreflight.integrity &&
          normalizeClawHubSha256Integrity(rawPreflight.integrity) ===
            normalizeClawHubSha256Integrity(pkg.integrity)
            ? { ...rawPreflight, ok: true as const, action: "install" as const }
            : rawPreflight;
        assertCurrent();
        if (!preflight.ok) {
          throw new Error(preflight.error);
        }
        if (
          preflight.action !== pkg.ownerAction ||
          preflight.warning !== pkg.riskWarning ||
          !preflight.integrity ||
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
            await persistForwardPackageRef({
              status: "complete",
              relationship: "managed",
              origin: "pre-existing",
              independentOwner: true,
            }),
          );
          continue;
        }
        if (pkg.riskWarning) {
          if (!options.skillConsent) {
            throw new ClawPackageInstallError(
              "skill_consent_required",
              `Skill ${pkg.ref}@${pkg.version} requires an explicit trust warning acknowledgement.`,
              installedPackages,
            );
          }
          options.skillConsent.assertApproved({
            ref: pkg.ref,
            version: pkg.version,
            integrity: pkg.integrity,
            riskWarning: pkg.riskWarning,
          });
        }
        let packageRef = await persistForwardPackageRef({
          status: "pending",
          relationship: "managed",
          origin: "claw-introduced",
          independentOwner: false,
        });
        installedPackages.push(packageRef);
        assertForwardCurrent();
        if (upgrade) {
          await upgrade.assertCurrent();
        }
        const installed = await installSkill({
          workspaceDir: plan.agent.workspace,
          slug: pkg.ref,
          version: pkg.version,
          expectedIntegrity: pkg.integrity,
          clawManaged: true,
          ...(upgrade
            ? { force: true, expectedClawHubState: upgrade.plan, deferCommit: true }
            : {}),
          beforePersistentApply: () => {
            assertForwardCurrent();
            if (!upgrade) {
              options.onExternalMutation?.(pkg);
            }
          },
          ...(upgrade ? { assertOwned: assertCurrent } : {}),
          confirmInstall: (warning) => {
            assertCurrent();
            return warning === pkg.riskWarning;
          },
        });
        assertCurrent();
        if (!installed.ok) {
          if (installed.recoveryIncomplete) {
            options.onExternalMutation?.(pkg);
          }
          throw new Error(installed.error);
        }
        if (upgrade) {
          if (!installed.transaction) {
            options.onExternalMutation?.(pkg);
            throw new Error(`Skill ${pkg.ref}@${pkg.version} returned no rollback receipt.`);
          }
          options.onSkillTransaction?.(pkg, installed.transaction);
        }
        if (installed.version !== pkg.version) {
          throw new Error(`Skill ${pkg.ref}@${pkg.version} changed during installation.`);
        }
        packageRef = await completeForwardPackageRef(packageRef, "complete");
        installedPackages[installedPackages.length - 1] = packageRef;
        continue;
      }

      const preflight = await preflightPlugin({
        clawhubPackage: pkg.ref,
        rawSpec: `clawhub:${pkg.ref}@${pkg.version}`,
        expectedVersion: pkg.version,
      });
      assertCurrent();
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
              refs: await readPackageRefs({
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
        inspectPluginCapabilities: deps.inspectPluginCapabilities,
        env: options.env,
        config: options.config,
        currentArtifactDir: preflight.installedPath,
      });
      assertCurrent();
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
        !pkg.declaredCapabilities ||
        stableStringify(probe.declaredCapabilities) !== stableStringify(pkg.declaredCapabilities) ||
        !pkg.capabilityGrants ||
        stableStringify(probe.capabilityGrants) !== stableStringify(pkg.capabilityGrants) ||
        !pkg.capabilityGrantsByPluginId ||
        stableStringify(probe.capabilityGrantsByPluginId) !==
          stableStringify(pkg.capabilityGrantsByPluginId) ||
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
      const capabilityReviewToken = computeDeclaredSurfaceHash(pkg.declaredCapabilities);
      const sourceHostConflict = sourceHostPluginConflict(pkg, probe.pluginId, options);
      if (sourceHostConflict) {
        throw new ClawPackageInstallError(
          "plugin_source_host_conflict",
          sourceHostConflict,
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
          assertForwardCurrent();
          options.runtimeBatch?.retain(probe.pluginId);
          installedPackages.push(
            await persistForwardPackageRef({
              status: "complete",
              relationship: resumableRequirement.relationship,
              origin: resumableRequirement.origin,
              independentOwner: resumableRequirement.independentOwner,
            }),
          );
          continue;
        }
        const existingRefs = await readPackageRefs({
          ...options,
          kind: pkg.kind,
          source: pkg.source,
          ref: pkg.ref,
          version: pkg.version,
        });
        const inheritsClawOrigin =
          existingRefs.length > 0 &&
          existingRefs.every(
            (candidate) => candidate.origin === "claw-introduced" && !candidate.independentOwner,
          ) &&
          !ownerInstallIsNewerThanRefs(preflight.installedAt, existingRefs);
        installedPackages.push(
          await persistForwardPackageRef({
            status: "complete",
            relationship: "referenced",
            origin: inheritsClawOrigin ? "claw-introduced" : "pre-existing",
            independentOwner: !inheritsClawOrigin,
          }),
        );
        continue;
      }

      const pluginConsent = options.pluginConsent;
      if (!pluginConsent) {
        throw new ClawPackageInstallError(
          "plugin_consent_required",
          `Plugin ${pkg.ref}@${pkg.version} requires an explicit Claw capability acknowledgment.`,
          installedPackages,
        );
      }

      let packageRef = await persistForwardPackageRef({
        status: "pending",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      });
      installedPackages.push(packageRef);

      assertForwardCurrent();
      const beforePluginCommit = bindClawPluginBeforeCommit(options, pkg, assertForwardCurrent);
      await installPlugin({
        request: {
          source: "clawhub",
          packageName: pkg.ref,
          version: pkg.version,
          mode: options.pluginInstallMode ?? "install",
          expectedIntegrity: pkg.integrity,
          expectedPluginId: probe.pluginId,
        },
        env: options.clawHubBaseUrl
          ? { ...options.env, OPENCLAW_CLAWHUB_URL: options.clawHubBaseUrl }
          : options.env,
        beforePersistentApply: assertForwardCurrent,
        onBeforePluginArtifactCommit: (artifact, config) => {
          const current = inspectClawPluginCapabilities(
            artifact.stagedArtifactDir,
            artifact.pluginId,
            options.env,
            config,
            artifact.currentArtifactDir,
          );
          if (
            stableStringify(current.grantsByPluginId) !==
            stableStringify(pkg.capabilityGrantsByPluginId)
          ) {
            throw new Error(
              `Plugin ${pkg.ref}@${pkg.version} effective capability grants changed after planning; run add --dry-run again.`,
            );
          }
        },
        beforePersistentEffect: beforePluginCommit,
        logger: createPluginInstallLogger(runtime),
        confirmInstall: async (warning) => {
          assertCurrent();
          if (warning !== pkg.riskWarning) {
            throw new ClawPackageInstallError(
              "package_owner_state_changed",
              `Plugin ${pkg.ref}@${pkg.version} trust state changed after planning; review the Claw again.`,
              installedPackages,
            );
          }
          return (await pluginConsent.confirmInstall?.(probe.pluginId, warning)) ?? true;
        },
        onCapabilityConsent: async (review) => {
          if (review.reviewToken !== capabilityReviewToken) {
            throw new Error(
              `Plugin ${pkg.ref}@${pkg.version} declared capabilities changed after planning; run add --dry-run again.`,
            );
          }
          if (stableStringify(review.grants) !== stableStringify(pkg.capabilityGrants)) {
            throw new Error(
              `Plugin ${pkg.ref}@${pkg.version} effective capability grants changed after planning; run add --dry-run again.`,
            );
          }
          return await pluginConsent.onCapabilityConsent(review);
        },
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
      assertCurrent();
      packageRef = await completeForwardPackageRef(packageRef, "complete");
      installedPackages[installedPackages.length - 1] = packageRef;
    } catch (error) {
      const pending = installedPackages.at(-1);
      if (pending?.status === "pending" && packageLease) {
        try {
          installedPackages[installedPackages.length - 1] = await withClawPackageRefWrite(
            packageLease,
            options,
            () => options.assertCurrent?.(),
            async (stateOptions) => await completePackageRef(pending, "failed", stateOptions),
          );
        } catch {
          // Preserve the installer error; pending provenance still exposes uncertain ownership.
        }
      }
      try {
        packageLease?.release();
        packageLease = null;
      } catch {
        // The rollback path will report a busy lease instead of mutating without ownership.
      }
      const rollbackErrors: string[] = [];
      for (const installedPlugin of installedPlugins.toReversed()) {
        const packageRef = installedPackages[installedPlugin.packageIndex];
        if (!packageRef) {
          continue;
        }
        let rollbackLease: MaintainedClawPackageLifecycleLease | null = null;
        try {
          const acquiredRollbackLease = acquirePackageLease(
            { kind: "plugin", source: "clawhub", ref: packageRef.ref },
            { env: options.env, path: options.path, required: true },
          );
          if (!acquiredRollbackLease) {
            throw new Error(`Could not acquire package lifecycle lease for ${packageRef.ref}.`, {
              cause: error,
            });
          }
          rollbackLease = maintainClawPackageLifecycleLease(acquiredRollbackLease);
          const activeRollbackLease = rollbackLease;
          const sharedRefs = (
            await readPackageRefs({
              ...options,
              kind: "plugin",
              source: "clawhub",
              ref: packageRef.ref,
              version: packageRef.version,
              integrity: packageRef.integrity,
            })
          ).filter(
            (ref) =>
              ref.agentId !== plan.agent.finalId &&
              (ref.status === "pending" || ref.status === "complete"),
          );
          if (sharedRefs.length > 0) {
            rollbackErrors.push(
              `kept plugin ${installedPlugin.installId} because another Claw now references it`,
            );
            continue;
          }
          const currentRefs = await readPackageRefs({
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
            continue;
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
            continue;
          }
          options.assertCurrent?.();
          await uninstallPlugin({
            pluginId: installedPlugin.installId,
            caller: "cli",
            invalidateRuntimeCache: false,
            clawManaged: true,
            beforePersistentApply: () => {
              rollbackLease?.assertCurrent();
              options.assertCurrent?.();
            },
            onWarning: (warning) => runtime.log(warning),
            deferRuntime: options.runtimeBatch?.install(),
          });
          rollbackLease.assertCurrent();
          options.assertCurrent?.();
          installedPackages[installedPlugin.packageIndex] = await withClawPackageRefWrite(
            activeRollbackLease,
            options,
            () => options.assertCurrent?.(),
            async (stateOptions) =>
              await completePackageRef(
                installedPackages[installedPlugin.packageIndex] ?? packageRef,
                "rolled_back",
                stateOptions,
              ),
          );
        } catch (rollbackError) {
          rollbackErrors.push(
            `could not remove plugin ${installedPlugin.installId}: ${coerceErrorMessage(rollbackError)}`,
          );
          continue;
        } finally {
          try {
            rollbackLease?.release();
          } catch {
            // Lease expiry recovers cleanup when the shared state database is unavailable.
          }
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
    } finally {
      try {
        packageLease?.release();
      } catch {
        // Lease expiry recovers cleanup when the shared state database is unavailable.
      }
    }
  }

  return installedPackages;
}
