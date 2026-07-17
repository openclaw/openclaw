import { runPluginInstallCommand } from "../cli/plugins-install-command.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  persistClawPackageRef,
  updateClawPackageRefStatus,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type { ClawAddPlan, ClawAddPlanAction, ClawPackage } from "./types.js";

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
  preflightPlugin?: typeof preflightPluginInstall;
  persistPackageRef?: typeof persistClawPackageRef;
  completePackageRef?: typeof updateClawPackageRefStatus;
};

type PlannedClawPackage = ClawPackage & { ownerAction: "install" | "reuse" };

function packageFromAction(action: ClawAddPlanAction): PlannedClawPackage {
  const details = action.details as
    | (Partial<ClawPackage> & { ownerAction?: "install" | "reuse" })
    | undefined;
  if (details?.kind !== "skill" && details?.kind !== "plugin") {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no valid package kind.`);
  }
  if (details.source !== "clawhub" || !details.ref || !details.version || !details.integrity) {
    throw new Error(
      `Package action ${JSON.stringify(action.id)} is not a pinned ClawHub package with integrity.`,
    );
  }
  if (details.ownerAction !== "install" && details.ownerAction !== "reuse") {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no planned owner state.`);
  }
  return {
    kind: details.kind,
    source: details.source,
    ref: details.ref,
    version: details.version,
    integrity: details.integrity,
    ownerAction: details.ownerAction,
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
  | { ok: true; action: "install" | "reuse" }
  | { ok: false; code: string; message: string };

export async function preflightClawPackage(pkg: ClawPackage): Promise<ClawPackagePreflightResult> {
  if (pkg.kind === "skill") {
    return {
      ok: false,
      code: "skill_package_preflight_unavailable",
      message: `Skill ${pkg.ref}@${pkg.version} cannot be preflighted until the skill lifecycle exposes a read-only preflight.`,
    };
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
  return { ok: true, action: result.action };
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
  const preflightPlugin = deps.preflightPlugin ?? preflightPluginInstall;
  const persistPackageRef = deps.persistPackageRef ?? persistClawPackageRef;
  const completePackageRef = deps.completePackageRef ?? updateClawPackageRefStatus;
  const runtime = options.runtime ?? defaultRuntime;
  const installedPackages: PersistedClawPackageRef[] = [];

  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    try {
      const pkg = packageFromAction(action);
      if (pkg.kind === "skill") {
        throw new ClawPackageInstallError(
          "skill_package_install_unavailable",
          `Skill ${pkg.ref}@${pkg.version} requires the later skill package lifecycle slice.`,
          installedPackages,
        );
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
      if (preflight.action === "reuse") {
        installedPackages.push(
          persistPackageRef(plan, pkg, {
            ...options,
            status: "complete",
            ownership: "independently-owned",
          }),
        );
        continue;
      }

      let packageRef = persistPackageRef(plan, pkg, {
        ...options,
        status: "pending",
        ownership: "claw-installed",
      });
      installedPackages.push(packageRef);

      await installPlugin({
        raw: `clawhub:${pkg.ref}@${pkg.version}`,
        opts: {},
        invalidateRuntimeCache: false,
        runtime: installerRuntime(runtime),
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
      if (error instanceof ClawPackageInstallError) {
        throw new ClawPackageInstallError(error.code, error.message, installedPackages);
      }
      throw new ClawPackageInstallError(
        "package_install_failed",
        error instanceof Error ? error.message : String(error),
        installedPackages,
      );
    }
  }

  return installedPackages;
}
