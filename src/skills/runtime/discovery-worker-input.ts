import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { capturePluginSkillContributions } from "../loading/plugin-skills.js";
import type { WorkspaceSkillSourcePlanOptions } from "../loading/workspace-skill-sources.js";
import type { WorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.types.js";
import {
  captureSkillsDiscoveryEnvironment,
  type SkillsSourcePlanInput,
} from "./discovery-worker-contract.js";

/** Capture policy once; selecting and reading filesystem roots stays on the worker. */
export function captureSkillsSourcePlanInput(
  workspaceDir: string,
  options: WorkspaceSkillSourcePlanOptions,
): SkillsSourcePlanInput {
  const { pluginMetadataSnapshot } = options;
  const acpRuntimeAvailable = isAcpRuntimeSpawnAvailable({ config: options.config });
  return {
    workspaceDir,
    environment: captureSkillsDiscoveryEnvironment(),
    options: {
      config: options.config,
      agentId: options.agentId,
      workspaceOnly: options.workspaceOnly,
      managedSkillsDir: options.managedSkillsDir,
      bundledSkillsDir: options.bundledSkillsDir,
      pluginSkillsDir: options.pluginSkillsDir,
    },
    acpRuntimeAvailable,
    ...(pluginMetadataSnapshot
      ? {
          pluginContributions: capturePluginSkillContributions({
            metadataSnapshot: pluginMetadataSnapshot,
            config: options.config,
            acpRuntimeAvailable,
          }),
        }
      : {}),
  };
}

export type SkillsWatcherParams = {
  workspaceDir: string;
  executionWorkspaceDir?: string;
  executionWorkspaceFileHost?: "gateway";
  config?: OpenClawConfig;
  agentId?: string;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  sourcePlan?: WorkspaceSkillSourcePlan;
};
