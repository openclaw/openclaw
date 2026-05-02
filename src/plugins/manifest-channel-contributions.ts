import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listPluginContributionIds, loadPluginRegistrySnapshot } from "./plugin-registry.js";

export function listManifestChannelContributionIds(
  params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeDisabled?: boolean;
  } = {},
): readonly string[] {
  const env = params.env ?? process.env;
  const index = loadPluginRegistrySnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
  });
  return listPluginContributionIds({
    index,
    contribution: "channels",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    includeDisabled: params.includeDisabled,
  });
}
