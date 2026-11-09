import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { preflightSkillFromClawHub } from "../skills/lifecycle/clawhub.js";
import { preflightBundledTemplateSkill } from "./bundled-skill.js";
import {
  preflightTemplatePluginPackage,
  type TemplatePluginProbeDeps,
} from "./plugin-capability-probe.js";
import type { TemplateDependency, TemplatePackagePreflightResult } from "./types.js";

export async function preflightTemplatePackage(
  pkg: TemplateDependency,
  workspaceDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    packageRoot?: string;
    snapshot?: import("./dependency-directory.js").TemplateDirectorySnapshot;
    config?: OpenClawConfig;
    deps?: { preflightPlugin?: typeof preflightPluginInstall } & TemplatePluginProbeDeps;
  } = {},
): Promise<TemplatePackagePreflightResult> {
  if (pkg.source === "bundled") {
    if (!options.packageRoot) {
      return {
        ok: false,
        code: "bundled_source_unavailable",
        message: "Bundled dependency has no package root.",
      };
    }
    return pkg.kind === "skill"
      ? preflightBundledTemplateSkill({
          rootDir: options.packageRoot,
          path: pkg.path,
          workspace: workspaceDir,
          snapshot: options.snapshot,
          config: options.config,
        })
      : {
          ok: false,
          code: "bundled_plugin_unavailable",
          message: "Bundled plugin installation is unavailable.",
        };
  }
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
