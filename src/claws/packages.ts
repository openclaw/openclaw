import { coerceErrorMessage, stableStringify } from "@openclaw/normalization-core";
import { createPluginInstallLogger } from "../cli/plugins-command-helpers.js";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import { installManagedPlugin } from "../plugins/management-mutations.js";
import { uninstallPluginWithPolicy } from "../plugins/management-uninstall.js";
import {
  preflightPluginInstall,
  resolveInstalledClawHubPlugin,
} from "../plugins/plugin-install-preflight.js";
import { defaultRuntime } from "../runtime.js";
import { installSkillFromClawHub, preflightSkillFromClawHub } from "../skills/lifecycle/clawhub.js";
import {
  acquireClawPackageLifecycleLease,
  maintainClawPackageLifecycleLease,
  type MaintainedClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import {
  persistClawPackageRefForAdd,
  readClawPackageRefsForAdd,
  updateClawPackageRefStatusForAdd,
} from "./add-state-write.js";
import type { InstallClawPackagesOptions } from "./package-install-options.js";
import { packageFromAction } from "./package-plan-action.js";
import { bindClawPluginBeforeCommit } from "./package-plugin-before-commit.js";
import { matchesPlannedPluginProbe } from "./package-plugin-probe-match.js";
import {
  acquireMaintainedClawPackageLease,
  createClawPackageRefWriter,
  withClawPackageRefWrite,
} from "./package-ref-state-write.js";
import {
  findResumableIntroducedPluginRequirement,
  ownerInstallIsNewerThanRefs,
} from "./package-resume.js";
import { createStatelessClawPackageReceipt } from "./package-stateless-receipt.js";
import { rollbackStatelessClawPackagesWithStamps } from "./package-stateless-rollback.js";
import {
  inspectClawPluginCapabilities,
  probeClawPluginArtifact,
  sourceHostPluginConflict,
} from "./plugin-capability-probe.js";
import { runClawPluginBatch } from "./plugin-runtime.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";

export { preflightClawPackage } from "./package-preflight.js";
export type {
  ClawPluginInstallConsent,
  ClawSkillInstallConsent,
} from "./package-install-options.js";

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

// A stateless Add keeps this receipt only until it succeeds or its rollback finishes.
const statelessPluginInstallStamps = new WeakMap<
  PersistedClawPackageRef,
  { pluginId: string; installedAt: string }
>();

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

/** Undo only plugin installs made by this in-flight Add, before its agent is published. */
export async function rollbackStatelessClawPackages(
  packages: PersistedClawPackageRef[],
  options: Pick<InstallClawPackagesOptions, "assertCurrent" | "env" | "path" | "runtime"> = {},
): Promise<string[]> {
  return await rollbackStatelessClawPackagesWithStamps(
    packages,
    options,
    statelessPluginInstallStamps,
  );
}

async function installClawPackagesUnlocked(
  plan: ClawAddPlan,
  options: InstallClawPackagesOptions,
): Promise<PersistedClawPackageRef[]> {
  const runtime = options.runtime ?? defaultRuntime;
  const installPlugin = async (params: Parameters<typeof installManagedPlugin>[0]) => {
    const result = await installManagedPlugin(params);
    for (const warning of result.warnings ?? []) {
      runtime.log(warning);
    }
    runtime.log(`Installed plugin requirement: ${result.plugin.id}`);
    if (!params.deferRuntime && !params.applyRuntime) {
      runtime.log("Restart the gateway to load plugins.");
    }
  };
  const uninstallPlugin = async (params: Parameters<typeof uninstallPluginWithPolicy>[0]) => {
    const result = await uninstallPluginWithPolicy(params);
    if (!result.ok) {
      throw new Error(result.error);
    }
    runtime.log(`Rolled back plugin requirement: ${result.value.pluginId}`);
  };
  const persistPackageRef: typeof persistClawPackageRefForAdd = options.stateless
    ? async (currentPlan, pkg, refOptions) =>
        createStatelessClawPackageReceipt(currentPlan, pkg, {
          ...refOptions,
          nowMs: refOptions?.nowMs ?? options.nowMs,
        })
    : persistClawPackageRefForAdd;
  const completePackageRef: typeof updateClawPackageRefStatusForAdd = options.stateless
    ? async (ref, status) => ({ ...ref, status, updatedAtMs: options.nowMs ?? Date.now() })
    : updateClawPackageRefStatusForAdd;
  const readPackageRefs = options.stateless ? async () => [] : readClawPackageRefsForAdd;
  const installedPackages: PersistedClawPackageRef[] = [];
  const installedPlugins: Array<{ installId: string; packageIndex: number }> = [];

  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    let packageLease: MaintainedClawPackageLifecycleLease | null = null;
    try {
      const pkg = packageFromAction(action);
      packageLease = await acquireMaintainedClawPackageLease(pkg, plan.agent.workspace, options);
      const forwardWriter = createClawPackageRefWriter(
        packageLease,
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
        const rawPreflight = await preflightSkillFromClawHub({
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
        const installed = await installSkillFromClawHub({
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
        if (!installed.ok && installed.recoveryIncomplete) {
          options.onExternalMutation?.(pkg);
        }
        if (installed.ok && upgrade) {
          if (installed.transaction) {
            options.onSkillTransaction?.(pkg, installed.transaction);
          } else {
            options.onExternalMutation?.(pkg);
          }
        }
        assertCurrent();
        if (!installed.ok) {
          throw new Error(installed.error);
        }
        if (upgrade) {
          if (!installed.transaction) {
            throw new Error(`Skill ${pkg.ref}@${pkg.version} returned no rollback receipt.`);
          }
        }
        if (installed.version !== pkg.version) {
          throw new Error(`Skill ${pkg.ref}@${pkg.version} changed during installation.`);
        }
        packageRef = await completeForwardPackageRef(packageRef, "complete");
        installedPackages[installedPackages.length - 1] = packageRef;
        continue;
      }

      const preflight = await preflightPluginInstall({
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
        env: options.env,
        config: options.config,
        currentArtifactDir: preflight.installedPath,
      });
      assertCurrent();
      if (!probe.ok) {
        throw new Error(probe.error);
      }
      if (!matchesPlannedPluginProbe(pkg, probe)) {
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
      const pluginCommit = bindClawPluginBeforeCommit(options, pkg, assertForwardCurrent);
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
        beforePersistentApply: pluginCommit.beforePersistentApply,
        onBeforePluginArtifactCommit: async (artifact) => {
          const { snapshot } = await readConfigFileSnapshotForWrite();
          const current = inspectClawPluginCapabilities(
            artifact.stagedArtifactDir,
            artifact.pluginId,
            options.env,
            snapshot.sourceConfig,
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
          pluginCommit.artifactReviewed();
        },
        beforePersistentEffect: pluginCommit.beforePersistentEffect,
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
      if (options.stateless) {
        const installed = await resolveInstalledClawHubPlugin({ clawhubPackage: pkg.ref });
        if (
          installed.status === "found" &&
          installed.pluginId === probe.pluginId &&
          installed.installedVersion === pkg.version &&
          installed.record.integrity &&
          normalizeClawHubSha256Integrity(installed.record.integrity) ===
            normalizeClawHubSha256Integrity(pkg.integrity) &&
          installed.record.installedAt
        ) {
          statelessPluginInstallStamps.set(packageRef, {
            pluginId: installed.pluginId,
            installedAt: installed.record.installedAt,
          });
        }
      }
      assertCurrent();
      const pendingRef = packageRef;
      packageRef = await completeForwardPackageRef(packageRef, "complete");
      const stamp = statelessPluginInstallStamps.get(pendingRef);
      if (stamp) {
        statelessPluginInstallStamps.set(packageRef, stamp);
      }
      installedPackages[installedPackages.length - 1] = packageRef;
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      const pending = installedPackages.at(-1);
      if (
        pending?.status === "pending" &&
        packageLease &&
        !statelessPluginInstallStamps.has(pending)
      ) {
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
        await packageLease?.release();
        packageLease = null;
      } catch {
        // The rollback path will report a busy lease instead of mutating without ownership.
      }
      const rollbackErrors: string[] = [];
      for (const installedPlugin of options.stateless ? [] : installedPlugins.toReversed()) {
        const packageRef = installedPackages[installedPlugin.packageIndex];
        if (!packageRef) {
          continue;
        }
        let rollbackLease: MaintainedClawPackageLifecycleLease | null = null;
        try {
          const acquiredRollbackLease = await acquireClawPackageLifecycleLease(
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
          const installed = await resolveInstalledClawHubPlugin({ clawhubPackage: packageRef.ref });
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
          if (hasSqliteWorkerOutcomeUnknown(rollbackError)) {
            throw rollbackError;
          }
          rollbackErrors.push(
            `could not remove plugin ${installedPlugin.installId}: ${coerceErrorMessage(rollbackError)}`,
          );
          continue;
        } finally {
          try {
            await rollbackLease?.release();
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
        await packageLease?.release();
      } catch {
        // Lease expiry recovers cleanup when the shared state database is unavailable.
      }
    }
  }

  return installedPackages;
}
