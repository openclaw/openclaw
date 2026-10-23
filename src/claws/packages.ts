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
  type ClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import { readClawPackageRefsForAdd } from "./add-state-write.js";
import type { InstallClawPackagesOptions } from "./package-install-options.js";
import { packageFromAction } from "./package-plan-action.js";
import { matchesPlannedPluginProbe } from "./package-plugin-probe-match.js";
import { createStatelessClawPackageReceipt } from "./package-stateless-receipt.js";
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
  const errors: string[] = [];
  const runtime = options.runtime ?? defaultRuntime;
  for (const pkg of packages.toReversed()) {
    if (pkg.kind !== "plugin" || pkg.origin !== "claw-introduced") {
      continue;
    }
    const stamp = statelessPluginInstallStamps.get(pkg);
    if (!stamp) {
      continue;
    }
    let lease: ClawPackageLifecycleLease | null = null;
    try {
      const acquired = await acquireClawPackageLifecycleLease(
        { kind: "plugin", source: "clawhub", ref: pkg.ref },
        { env: options.env, path: options.path, required: true },
      );
      if (!acquired) {
        throw new Error(`Could not acquire package lifecycle lease for ${pkg.ref}.`);
      }
      lease = acquired;
      const owners = await readClawPackageRefsForAdd({
        ...options,
        kind: "plugin",
        source: "clawhub",
        ref: pkg.ref,
        version: pkg.version,
        integrity: pkg.integrity,
      });
      if (owners.some((owner) => owner.status === "pending" || owner.status === "complete")) {
        continue;
      }
      const installed = await resolveInstalledClawHubPlugin({ clawhubPackage: pkg.ref });
      if (
        installed.status !== "found" ||
        installed.pluginId !== stamp.pluginId ||
        installed.record.installedAt !== stamp.installedAt ||
        installed.installedVersion !== pkg.version ||
        !installed.record.integrity ||
        normalizeClawHubSha256Integrity(installed.record.integrity) !==
          normalizeClawHubSha256Integrity(pkg.integrity)
      ) {
        continue;
      }
      const activeLease = lease;
      // The Add batch may be closed; CLI uninstall schedules its own runtime restart.
      const params: Parameters<typeof uninstallPluginWithPolicy>[0] = {
        pluginId: installed.pluginId,
        caller: "cli",
        invalidateRuntimeCache: false,
        clawManaged: true,
        beforePersistentApply: () => {
          activeLease.assertCurrent();
          options.assertCurrent?.();
        },
        onWarning: (warning) => runtime.log(warning),
      };
      options.assertCurrent?.();
      const removed = await uninstallPluginWithPolicy(params);
      if (!removed.ok) {
        throw new Error(removed.error);
      }
      pkg.status = "rolled_back";
    } catch (error) {
      errors.push(`plugin ${pkg.ref} cleanup failed: ${coerceErrorMessage(error)}`);
    } finally {
      try {
        await lease?.release();
      } catch (error) {
        errors.push(`plugin ${pkg.ref} cleanup lease failed: ${coerceErrorMessage(error)}`);
      }
    }
  }
  return errors;
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
  const installedPackages: PersistedClawPackageRef[] = [];

  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    let packageLease: ClawPackageLifecycleLease | null = null;
    try {
      const pkg = packageFromAction(action);
      const leaseArtifact =
        pkg.kind === "skill"
          ? { kind: pkg.kind, source: pkg.source, ref: pkg.ref, workspace: plan.agent.workspace }
          : { kind: pkg.kind, source: pkg.source, ref: pkg.ref };
      const acquired = await acquireClawPackageLifecycleLease(leaseArtifact, {
        env: options.env,
        path: options.path,
        required: true,
      });
      if (!acquired) {
        throw new Error(`Could not acquire package lifecycle lease for ${pkg.ref}.`);
      }
      packageLease = acquired;
      const assertCurrent = () => {
        acquired.assertCurrent();
        options.assertCurrent?.();
      };
      const assertForwardCurrent = () => {
        assertCurrent();
        options.assertForwardCurrent?.();
      };
      if (pkg.kind === "skill") {
        const preflight = await preflightSkillFromClawHub({
          workspaceDir: plan.agent.workspace,
          slug: pkg.ref,
          version: pkg.version,
          expectedIntegrity: pkg.integrity,
        });
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
            createStatelessClawPackageReceipt(plan, pkg, {
              nowMs: options.nowMs,
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
        let packageRef = createStatelessClawPackageReceipt(plan, pkg, {
          nowMs: options.nowMs,
          status: "pending",
          relationship: "managed",
          origin: "claw-introduced",
          independentOwner: false,
        });
        installedPackages.push(packageRef);
        assertForwardCurrent();
        const installed = await installSkillFromClawHub({
          workspaceDir: plan.agent.workspace,
          slug: pkg.ref,
          version: pkg.version,
          expectedIntegrity: pkg.integrity,
          clawManaged: true,
          beforePersistentApply: assertForwardCurrent,
          confirmInstall: (warning) => {
            assertCurrent();
            return warning === pkg.riskWarning;
          },
        });
        assertCurrent();
        if (!installed.ok) {
          throw new Error(installed.error);
        }
        if (installed.version !== pkg.version) {
          throw new Error(`Skill ${pkg.ref}@${pkg.version} changed during installation.`);
        }
        assertForwardCurrent();
        packageRef = {
          ...packageRef,
          status: "complete",
          updatedAtMs: options.nowMs ?? Date.now(),
        };
        installedPackages[installedPackages.length - 1] = packageRef;
        continue;
      }

      const preflight = await preflightPluginInstall({
        clawhubPackage: pkg.ref,
        expectedVersion: pkg.version,
      });
      assertCurrent();
      if (!preflight.ok) {
        throw new Error(
          `Plugin ${pkg.ref}@${pkg.version} conflicts with installed version ${preflight.installedVersion}.`,
        );
      }
      if (preflight.action !== pkg.ownerAction) {
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
      const sourceHostConflict = await sourceHostPluginConflict(pkg, probe.pluginId, options);
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
        installedPackages.push(
          createStatelessClawPackageReceipt(plan, pkg, {
            nowMs: options.nowMs,
            status: "complete",
            relationship: "referenced",
            origin: "pre-existing",
            independentOwner: true,
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

      let packageRef = createStatelessClawPackageReceipt(plan, pkg, {
        nowMs: options.nowMs,
        status: "pending",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      });
      installedPackages.push(packageRef);

      assertForwardCurrent();
      await installPlugin({
        request: {
          source: "clawhub",
          packageName: pkg.ref,
          version: pkg.version,
          mode: "install",
          expectedIntegrity: pkg.integrity,
          expectedPluginId: probe.pluginId,
        },
        env: options.clawHubBaseUrl
          ? { ...options.env, OPENCLAW_CLAWHUB_URL: options.clawHubBaseUrl }
          : options.env,
        beforePersistentApply: assertForwardCurrent,
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
        },
        beforePersistentEffect: async () => assertForwardCurrent(),
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
      assertCurrent();
      const pendingRef = packageRef;
      assertForwardCurrent();
      packageRef = { ...packageRef, status: "complete", updatedAtMs: options.nowMs ?? Date.now() };
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
          packageLease.assertCurrent();
          options.assertCurrent?.();
          installedPackages[installedPackages.length - 1] = {
            ...pending,
            status: "failed",
            updatedAtMs: options.nowMs ?? Date.now(),
          };
        } catch {
          // Preserve the installer error and its pending in-memory receipt.
        }
      }
      try {
        await packageLease?.release();
        packageLease = null;
      } catch {
        // The rollback path will report a busy lease instead of mutating without ownership.
      }
      const message = coerceErrorMessage(error);
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
