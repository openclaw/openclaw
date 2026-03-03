import type { OpenClawConfig } from "../config/config.js";
import type { DmScope } from "../config/types.base.js";
import type { ToolProfileId } from "../config/types.tools.js";

export const ONBOARDING_DEFAULT_DM_SCOPE: DmScope = "per-channel-peer";
// Note: Do NOT set a default tools profile here. Setting tools.profile to "messaging"
// breaks the onboarding flow because agents cannot write files without tools.
// Interactive onboarding does not set a tools profile, so non-interactive should match that behavior.
// See issue #33225.
export const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId | undefined = undefined;

export function applyOnboardingLocalWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
): OpenClawConfig {
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
    tools:
      baseConfig.tools?.profile !== undefined
        ? baseConfig.tools
        : { ...baseConfig.tools, profile: ONBOARDING_DEFAULT_TOOLS_PROFILE },
  };
}
