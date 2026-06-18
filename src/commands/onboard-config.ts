/** Shared config mutations used by interactive and non-interactive onboarding. */
import { setConfigValueAtPath } from "../config/config-paths.js";
import type { DmScope } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolProfileId } from "../config/types.tools.js";
import { normalizeAgentId } from "../routing/session-key.js";

/** Default DM scoping selected during local onboarding. */
const ONBOARDING_DEFAULT_DM_SCOPE: DmScope = "per-channel-peer";
/** Default tool profile selected during local onboarding. */
const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "coding";

/** Applies local gateway/workspace defaults without overwriting explicit user defaults. */
export function applyLocalSetupWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
  options: { agentId?: string; preserveInheritedAgentWorkspace?: boolean } = {},
): OpenClawConfig {
  const agentId = options.agentId ? normalizeAgentId(options.agentId) : undefined;
  const targetAgentIndex = agentId
    ? (baseConfig.agents?.list?.findIndex((entry) => normalizeAgentId(entry.id) === agentId) ?? -1)
    : -1;
  const targetAgentOwnsWorkspace =
    targetAgentIndex >= 0 &&
    Boolean(baseConfig.agents?.list?.[targetAgentIndex]?.workspace?.trim());
  const writeTargetAgentWorkspace =
    targetAgentIndex >= 0 && (!options.preserveInheritedAgentWorkspace || targetAgentOwnsWorkspace);
  const agents =
    targetAgentIndex >= 0
      ? {
          ...baseConfig.agents,
          list: baseConfig.agents?.list?.map((entry, index) =>
            index === targetAgentIndex && writeTargetAgentWorkspace
              ? { ...entry, workspace: workspaceDir }
              : entry,
          ),
        }
      : {
          ...baseConfig.agents,
          defaults: {
            ...baseConfig.agents?.defaults,
            workspace: workspaceDir,
          },
        };
  return {
    ...baseConfig,
    agents,
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

/** Marks default agents to skip bootstrap file creation. */
export function applySkipBootstrapConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = structuredClone(cfg);
  setConfigValueAtPath(
    next as Record<string, unknown>,
    ["agents", "defaults", "skipBootstrap"],
    true,
  );
  return next;
}
