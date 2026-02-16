import type { SmartAgentNeoConfig } from "../config/config.js";

export function applyOnboardingLocalWorkspaceConfig(
  baseConfig: SmartAgentNeoConfig,
  workspaceDir: string,
): SmartAgentNeoConfig {
  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        workspace: workspaceDir,
      },
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
  };
}
