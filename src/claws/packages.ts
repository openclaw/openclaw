import { runPluginInstallCommand } from "../cli/plugins-install-command.js";
import { runPluginUninstallCommand } from "../cli/plugins-uninstall-command.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub.js";
import { installPluginFromClawHub } from "../plugins/clawhub.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { installSkillFromClawHub, preflightSkillFromClawHub } from "../skills/lifecycle/clawhub.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  persistClawPackageRef,
  readClawPackageRefs,
  updateClawPackageRefStatus,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type { ClawAddPlan, ClawAddPlanAction, ClawPackage, ResolvedClawPackage } from "./types.js";

export class ClawPackageInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly installedPackages: PersistedClawPackageRef[],
  ) {
    super(message);
    this.name = "ClawPackageInstallError";
  }
}

type PackageInstallerDeps = {
  installPlugin?: typeof runPluginInstallCommand;
  uninstallPlugin?: typeof runPluginUninstallCommand;
  installSkill?: typeof installSkillFromClawHub;
  preflightPlugin?: typeof preflightPluginInstall;
  preflightSkill?: typeof preflightSkillFromClawHub;
  persistPackageRef?: typeof persistClawPackageRef;
  completePackageRef?: typeof updateClawPackageRefStatus;
  readPackageRefs?: typeof readClawPackageRefs;
};

type PlannedClawPackage = ResolvedClawPackage & {
  ownerAction: "install" | "reuse";
  installId?: string;
};
function packageFromAction(action: ClawAddPlanAction): PlannedClawPackage {
  const details = action.details as
    | (Partial<ResolvedClawPackage> & {
        ownerAction?: "install" | "reuse";
        installId?: string;
      })
    | undefined;
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
    ...(details.installId ? { installId: details.installId } : {}),
  };
}

function installerRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return {
    log: (value) => runtime.log(value),
    error: (value) => runtime.error(value),
    exit: (code) => {
      throw new Error(`Plugin installer exited with code ${code}.`);
    },
  };
}

type ClawPackagePreflightResult =
  | { ok: true; action: "install" | "reuse"; integrity: string; installId?: string }
  | { ok: false; code: string; message: string };

export async function preflightClawPackage(
  pkg: ClawPackage,
  workspaceDir: string,
): Promise<ClawPackagePreflightResult> {
  if (pkg.kind === "skill") {
    const result = await preflightSkillFromClawHub({
      workspaceDir,
      slug: pkg.ref,
      version: pkg.version,
      acknowledgeClawHubRisk: true,
    });
    return result.ok ? result : { ok: false, code: result.code, message: result.error };
  }
  const result = await preflightPluginInstall({
    clawhubPackage: pkg.ref,
    rawSpec: `clawhub:${pkg.ref}@${pkg.version}`,
    expectedVersion: pkg.version,
  });
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      message:
        result.code === "plugin_version_conflict"
          ? `Plugin ${pkg.ref}@${pkg.version} conflicts with installed version ${result.installedVersion}.`
          : result.error,
    };
  }
  const probe = await installPluginFromClawHub({
    spec: `clawhub:${pkg.ref}@${pkg.version}`,
    dryRun: true,
    acknowledgeClawHubRisk: true,
  });
  if (!probe.ok) {
    return { ok: false, code: probe.code ?? "plugin_preflight_failed", message: probe.error };
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
  return { ok: true, action: result.action, integrity, installId: probe.pluginId };
}

export async function installClawPackages(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    deps?: PackageInstallerDeps;
    runtime?: RuntimeEnv;
    nowMs?: number;
  } = {},
): Promise<PersistedClawPackageRef[]> {
  const deps = options.deps ?? {};
  const installPlugin = deps.installPlugin ?? runPluginInstallCommand;
  const uninstallPlugin = deps.uninstallPlugin ?? runPluginUninstallCommand;
  const installSkill = deps.installSkill ?? installSkillFromClawHub;
  const preflightPlugin = deps.preflightPlugin ?? preflightPluginInstall;
  const preflightSkill = deps.preflightSkill ?? preflightSkillFromClawHub;
  const persistPackageRef = deps.persistPackageRef ?? persistClawPackageRef;
  const completePackageRef = deps.completePackageRef ?? updateClawPackageRefStatus;
  const readPackageRefs = deps.readPackageRefs ?? readClawPackageRefs;
  const runtime = options.runtime ?? defaultRuntime;
  const installedPackages: PersistedClawPackageRef[] = [];
  const installedPlugins: Array<{ installId: string; packageIndex: number }> = [];

  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    try {
      const pkg = packageFromAction(action);
      if (pkg.kind === "skill") {
        const preflight = await preflightSkill({
          workspaceDir: plan.agent.workspace,
          slug: pkg.ref,
          version: pkg.version,
          expectedIntegrity: pkg.integrity,
          acknowledgeClawHubRisk: true,
        });
        if (!preflight.ok) {
          throw new Error(preflight.error);
        }
        if (
          preflight.action !== pkg.ownerAction ||
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
          continue;
        }
        let packageRef = persistPackageRef(plan, pkg, {
          ...options,
          status: "pending",
          relationship: "managed",
          origin: "claw-introduced",
          independentOwner: false,
        });
        installedPackages.push(packageRef);
        const installed = await installSkill({
          workspaceDir: plan.agent.workspace,
          slug: pkg.ref,
          version: pkg.version,
          expectedIntegrity: pkg.integrity,
          acknowledgeClawHubRisk: true,
        });
        if (!installed.ok) {
          throw new Error(installed.error);
        }
        packageRef = completePackageRef(packageRef, "complete", options);
        installedPackages[installedPackages.length - 1] = packageRef;
        continue;
      }

      const preflight = await preflightPlugin({
        clawhubPackage: pkg.ref,
        rawSpec: `clawhub:${pkg.ref}@${pkg.version}`,
        expectedVersion: pkg.version,
      });
      if (!preflight.ok) {
        throw new Error(
          preflight.code === "plugin_version_conflict"
            ? `Plugin ${pkg.ref}@${pkg.version} conflicts with installed version ${preflight.installedVersion}.`
            : preflight.error,
        );
      }
      if (preflight.action !== pkg.ownerAction) {
        throw new ClawPackageInstallError(
          "package_owner_state_changed",
          `Plugin ${pkg.ref}@${pkg.version} owner state changed from ${pkg.ownerAction} to ${preflight.action}; run add --dry-run again.`,
          installedPackages,
        );
      }
      if (!pkg.installId) {
        throw new ClawPackageInstallError(
          "plugin_identity_unresolved",
          `Plugin ${pkg.ref}@${pkg.version} has no resolved install identity.`,
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
          persistPackageRef(plan, pkg, {
            ...options,
            status: "complete",
            relationship: "referenced",
            origin: "pre-existing",
            independentOwner: true,
          }),
        );
        continue;
      }

      let packageRef = persistPackageRef(plan, pkg, {
        ...options,
        status: "pending",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      });
      installedPackages.push(packageRef);

      await installPlugin({
        raw: `clawhub:${pkg.ref}@${pkg.version}`,
        opts: {
          acknowledgeClawHubRisk: true,
          expectedIntegrity: pkg.integrity,
          expectedPluginId: pkg.installId,
        },
        invalidateRuntimeCache: false,
        runtime: installerRuntime(runtime),
      });
      installedPlugins.push({
        installId: pkg.installId,
        packageIndex: installedPackages.length - 1,
      });
      packageRef = completePackageRef(packageRef, "complete", options);
      installedPackages[installedPackages.length - 1] = packageRef;
    } catch (error) {
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
        let sharedRefs: PersistedClawPackageRef[];
        try {
          sharedRefs = readPackageRefs({
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
        } catch (rollbackError) {
          rollbackErrors.push(
            `could not verify exclusive ownership of plugin ${installedPlugin.installId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
          continue;
        }
        if (sharedRefs.length > 0) {
          rollbackErrors.push(
            `kept plugin ${installedPlugin.installId} because another Claw now references it`,
          );
          continue;
        }
        try {
          await uninstallPlugin(
            installedPlugin.installId,
            { force: true, invalidateRuntimeCache: false },
            installerRuntime(runtime),
          );
          installedPackages[installedPlugin.packageIndex] = completePackageRef(
            installedPackages[installedPlugin.packageIndex] ?? packageRef,
            "rolled_back",
            options,
          );
        } catch (rollbackError) {
          rollbackErrors.push(
            `could not remove plugin ${installedPlugin.installId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      if (rollbackErrors.length > 0) {
        throw new ClawPackageInstallError(
          "package_rollback_failed",
          `${message} Rollback incomplete: ${rollbackErrors.join("; ")}.`,
          installedPackages,
        );
      }
      if (error instanceof ClawPackageInstallError) {
        throw new ClawPackageInstallError(error.code, error.message, installedPackages);
      }
      throw new ClawPackageInstallError("package_install_failed", message, installedPackages);
    }
  }

  return installedPackages;
}
