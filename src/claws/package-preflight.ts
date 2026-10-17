import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { preflightSkillFromClawHub } from "../skills/lifecycle/clawhub.js";
import { preflightClawPluginPackage, type ClawPluginProbeDeps } from "./plugin-capability-probe.js";
import type { ClawPackage, ClawPackagePreflightResult } from "./types.js";

export async function preflightClawPackage(
  pkg: ClawPackage,
  workspaceDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    config?: OpenClawConfig;
    deps?: { preflightPlugin?: typeof preflightPluginInstall } & ClawPluginProbeDeps;
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
