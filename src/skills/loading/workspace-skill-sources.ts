import {
  capturePluginAgentSkillsDirs,
  resolvePluginAgentSkillsDirs,
  resolvePluginSkillRoots,
  resolvePluginSkillRootsFromMetadata,
} from "./plugin-skills.js";
import { resolvePluginSkillsDir } from "./skill-paths.js";
import {
  composeWorkspaceSkillSourcePlan,
  type WorkspaceSkillSourcePlanOptions,
} from "./workspace-skill-source-plan.js";
export type {
  WorkspaceSkillSources,
  WorkspaceSkillSourceRequest,
  WorkspaceSkillSourcePlan,
} from "./workspace-skill-sources.types.js";
export type { WorkspaceSkillSourcePlanOptions } from "./workspace-skill-source-plan.js";
export function resolveWorkspaceSkillSourcePlan(
  workspaceDir: string,
  opts?: WorkspaceSkillSourcePlanOptions,
) {
  const workspaceOnly = opts?.workspaceOnly === true;
  const pluginSkillsDir = opts?.pluginSkillsDir ?? resolvePluginSkillsDir();
  const pluginParams = { workspaceDir, config: opts?.config, pluginSkillsDir };
  const pluginSkillRoots = workspaceOnly
    ? []
    : (opts?.pluginSkillRoots ??
      (opts?.pluginMetadataSnapshot
        ? resolvePluginSkillRootsFromMetadata({
            ...pluginParams,
            metadataSnapshot: opts.pluginMetadataSnapshot,
          })
        : resolvePluginSkillRoots(pluginParams)));
  const agentSkillsDirs =
    workspaceOnly || !opts?.config || !opts.agentId
      ? []
      : (opts.agentSkillsDirs ??
        (opts.pluginMetadataSnapshot
          ? capturePluginAgentSkillsDirs({
              config: opts.config,
              metadataSnapshot: opts.pluginMetadataSnapshot,
            })
          : resolvePluginAgentSkillsDirs(pluginParams)));

  return composeWorkspaceSkillSourcePlan(workspaceDir, {
    ...opts,
    pluginSkillsDir,
    pluginSkillRoots,
    agentSkillsDirs,
  });
}
