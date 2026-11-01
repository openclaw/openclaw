import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { preflightSkillFromClawHub } from "../skills/lifecycle/clawhub.js";
import {
  preflightTemplatePluginPackage,
  type TemplatePluginProbeDeps,
} from "./plugin-capability-probe.js";
import type { TemplatePackage, TemplatePackagePreflightResult } from "./types.js";

export async function preflightTemplatePackage(
  pkg: TemplatePackage,
  workspaceDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    config?: OpenClawConfig;
    deps?: { preflightPlugin?: typeof preflightPluginInstall } & TemplatePluginProbeDeps;
  } = {},
): Promise<TemplatePackagePreflightResult> {
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
  return await preflightTemplatePluginPackage(pkg, options);
}
