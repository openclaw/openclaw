import { resolveUserTimezone } from "../agents/date-time.js";
import type { OpenClawConfig } from "../config/config.js";
import type { DmScope } from "../config/types.base.js";
import type { ToolProfileId } from "../config/types.tools.js";

export const ONBOARDING_DEFAULT_DM_SCOPE: DmScope = "per-channel-peer";
export const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "coding";

export function applyOnboardAgentDefaults(baseConfig: OpenClawConfig): OpenClawConfig["agents"] {
  return {
    ...baseConfig.agents,
    defaults: {
      ...baseConfig.agents?.defaults,
      userTimezone: baseConfig.agents?.defaults?.userTimezone ?? resolveUserTimezone(undefined),
    },
  };
}

export function applyLocalSetupWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
): OpenClawConfig {
  const agentDefaults = applyOnboardAgentDefaults(baseConfig);
  return {
    ...baseConfig,
    agents: {
      ...agentDefaults,
      defaults: {
        ...agentDefaults?.defaults,
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
    tools: {
      ...baseConfig.tools,
      profile: baseConfig.tools?.profile ?? ONBOARDING_DEFAULT_TOOLS_PROFILE,
    },
  };
}
