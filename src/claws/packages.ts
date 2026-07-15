import { runPluginInstallCommand } from "../cli/plugins-install-command.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { installSkillFromClawHub } from "../skills/lifecycle/clawhub.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { persistClawPackageRef, type PersistedClawPackageRef } from "./provenance.js";
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
  installSkill?: typeof installSkillFromClawHub;
  installPlugin?: typeof runPluginInstallCommand;
  preflightPlugin?: typeof preflightPluginInstall;
  persistPackageRef?: typeof persistClawPackageRef;
};

function packageFromAction(action: ClawAddPlanAction): ClawPackage {
  const details = action.details as Partial<ClawPackage> | undefined;
  if (details?.kind !== "skill" && details?.kind !== "plugin") {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no valid package kind.`);
  }
  if (details.source !== "clawhub" || !details.ref || !details.version) {
    throw new Error(`Package action ${JSON.stringify(action.id)} is not a pinned ClawHub package.`);
  }
  return {
    kind: details.kind,
    source: details.source,
    ref: details.ref,
    version: details.version,
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

export type ClawPackagePreflightResult =
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
  const installSkill = deps.installSkill ?? installSkillFromClawHub;
  const installPlugin = deps.installPlugin ?? runPluginInstallCommand;
  const preflightPlugin = deps.preflightPlugin ?? preflightPluginInstall;
  const persistPackageRef = deps.persistPackageRef ?? persistClawPackageRef;
  const runtime = options.runtime ?? defaultRuntime;
  const installedPackages: PersistedClawPackageRef[] = [];

  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    try {
      const pkg = packageFromAction(action);
      if (pkg.kind === "skill") {
        const result = await installSkill({
          workspaceDir: plan.agent.workspace,
          slug: pkg.ref,
          version: pkg.version,
          logger: {
            info: (message) => runtime.log(message),
            warn: (message) => runtime.log(message),
          },
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
      } else {
        // Recheck at mutation time so a concurrent install cannot make the dry-run
        // decision stale. Exact reuse gains a Claw reference but never reinstalls.
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
        if (preflight.action === "install") {
          await installPlugin({
            raw: `clawhub:${pkg.ref}@${pkg.version}`,
            opts: {},
            invalidateRuntimeCache: false,
            runtime: installerRuntime(runtime),
          });
        }
      }
      installedPackages.push(persistPackageRef(plan, pkg, options));
    } catch (error) {
      throw new ClawPackageInstallError(
        "package_install_failed",
        error instanceof Error ? error.message : String(error),
        installedPackages,
      );
    }
  }

  return installedPackages;
}
