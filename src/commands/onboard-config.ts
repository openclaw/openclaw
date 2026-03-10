import type { OpenClawConfig } from "../config/config.js";
import type { DmScope } from "../config/types.base.js";
import type { ToolProfileId } from "../config/types.tools.js";

export const ONBOARDING_DEFAULT_DM_SCOPE: DmScope = "per-channel-peer";
export const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "coding";

export function applyOnboardingLocalWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
  options?: { hasExistingConfig?: boolean },
): OpenClawConfig {
  const nextTools =
    baseConfig.tools?.profile !== undefined
      ? {
          ...baseConfig.tools,
          profile: baseConfig.tools.profile,
        }
      : options?.hasExistingConfig
        ? baseConfig.tools
        : {
            ...baseConfig.tools,
            profile: ONBOARDING_DEFAULT_TOOLS_PROFILE,
          };

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
    session: {
      ...baseConfig.session,
      dmScope: baseConfig.session?.dmScope ?? ONBOARDING_DEFAULT_DM_SCOPE,
    },
    ...(nextTools ? { tools: nextTools } : {}),
  };
}
