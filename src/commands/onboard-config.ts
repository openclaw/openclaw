import type { OpenClawConfig } from "../config/config.js";
import type { DmScope } from "../config/types.base.js";
import type { ToolProfileId } from "../config/types.tools.js";

export const ONBOARDING_DEFAULT_DM_SCOPE: DmScope = "per-channel-peer";
export const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "coding";

/** Returns true if the user has an explicit agents.defaults.userTimezone entry (including ""). */
export function hasExplicitUserTimezone(baseConfig: OpenClawConfig): boolean {
  return (
    Object.prototype.hasOwnProperty.call(baseConfig.agents?.defaults ?? {}, "userTimezone") &&
    baseConfig.agents?.defaults?.userTimezone !== undefined
  );
}

export function applyOnboardAgentDefaults(baseConfig: OpenClawConfig): OpenClawConfig["agents"] {
  // Intentionally does NOT set userTimezone — leave it unset so runtime detection
  // (resolveUserTimezone in src/agents/date-time.ts) always reflects the current host
  // timezone rather than snapshotting the onboarding-time value into config.
  // An explicit user-configured value (including "") is preserved via the spread of baseConfig.agents?.defaults.
  return {
    ...baseConfig.agents,
    defaults: {
      ...baseConfig.agents?.defaults,
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
