import fs from "node:fs";
import path from "node:path";
import { listAgentEntries, resolveAgentConfig } from "../agents/agent-scope-config.js";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolProfileId } from "../config/types.tools.js";
import { resolveUserPath } from "../utils.js";

const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "full";

const TOOL_PROFILE_SUMMARIES: Record<ToolProfileId, string> = {
  minimal:
    "This profile only lets the agent check its status: no files, commands, web or messages.",
  coding:
    "This profile allows files, commands, the web, memory and sessions, but not channel messages.",
  messaging: "This profile allows chat, messages and sessions, but not files, commands or the web.",
  full: "This profile allows every tool, including files, commands, the web and plugins.",
};

type ToolPolicyKeys = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  byProvider?: Record<string, unknown>;
};

function listToolPolicyKeys(tools: ToolPolicyKeys | undefined, at: string | undefined): string[] {
  if (!tools || !at) {
    return [];
  }
  return (["allow", "alsoAllow", "deny", "byProvider"] as const)
    .filter((key) => Object.keys(tools[key] ?? {}).length > 0)
    .map((key) => `${at}.${key}`);
}

export type OnboardingWorkspaceConflict = {
  currentWorkspaceDir: string;
  requestedWorkspaceDir: string;
};

function hasExistingAgentState(env: NodeJS.ProcessEnv): boolean {
  const stateDir = resolveStateDir(env);
  const agentsDir = path.join(stateDir, "agents");
  try {
    if (fs.readdirSync(agentsDir, { withFileTypes: true }).some((entry) => entry.isDirectory())) {
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return true;
    }
  }
  return [path.join(stateDir, "agent"), path.join(stateDir, "sessions")].some((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  });
}

export function resolveOnboardingWorkspaceConflict(
  baseConfig: OpenClawConfig,
  requestedWorkspaceDir: string,
  env: NodeJS.ProcessEnv = process.env,
): OnboardingWorkspaceConflict | undefined {
  const configuredWorkspace = baseConfig.agents?.defaults?.workspace?.trim();
  const currentWorkspaceDir = configuredWorkspace
    ? resolveUserPath(configuredWorkspace, env)
    : resolveDefaultAgentWorkspaceDir(env);
  const normalizedCurrent = path.resolve(currentWorkspaceDir);
  const normalizedRequested = path.resolve(resolveUserPath(requestedWorkspaceDir, env));
  if (normalizedCurrent === normalizedRequested) {
    return undefined;
  }

  const hasRoster = listAgentEntries(baseConfig).length > 0;
  if (!hasRoster && !(configuredWorkspace && hasExistingAgentState(env))) {
    return undefined;
  }
  return {
    currentWorkspaceDir: normalizedCurrent,
    requestedWorkspaceDir: normalizedRequested,
  };
}

// Deliberately writes no session.dmScope: the schema default "main" (one rolling
// personal-agent session across channels) is the product default. Multi-user DM
// isolation is opt-in; `openclaw security audit` nudges it when traffic warrants.
export function applyLocalSetupWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
  options: {
    allowWorkspaceChange?: boolean;
    preserveWorkspace?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): OpenClawConfig {
  const shouldUpdateWorkspace =
    !options.preserveWorkspace &&
    (options.allowWorkspaceChange ||
      (listAgentEntries(baseConfig).length === 0 &&
        !resolveOnboardingWorkspaceConflict(baseConfig, workspaceDir, options.env)));
  return {
    ...baseConfig,
    ...(shouldUpdateWorkspace
      ? {
          agents: {
            ...baseConfig.agents,
            defaults: {
              ...baseConfig.agents?.defaults,
              workspace: workspaceDir,
            },
          },
        }
      : {}),
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
    tools: {
      ...baseConfig.tools,
      profile: baseConfig.tools?.profile ?? ONBOARDING_DEFAULT_TOOLS_PROFILE,
    },
  };
}

/** Says which tool profile the agent ends setup with, what it allows, and how to widen it. */
export function describeSetupToolProfile(
  config: OpenClawConfig,
  agentId: string,
): string | undefined {
  const policy = resolveEffectiveToolPolicy({ config, agentId });
  const { profile, sources } = policy;
  const profilePath = sources.profile?.path;
  if (!profile || !profilePath) {
    return undefined;
  }
  const parts = [`Tool profile: ${profile} (${profilePath}).`, TOOL_PROFILE_SUMMARIES[profile]];
  // Setup keeps allow, alsoAllow, deny and provider policies; they change what the profile gives.
  const agentTools = policy.agentId ? resolveAgentConfig(config, policy.agentId)?.tools : undefined;
  const otherSettings = [
    ...listToolPolicyKeys(config.tools, "tools"),
    ...listToolPolicyKeys(agentTools, sources.agent?.path),
  ];
  if (otherSettings.length > 0) {
    parts.push(
      `These settings also change which tools the agent gets: ${otherSettings.join(", ")}.`,
    );
  }
  if (profile !== "full") {
    const alsoAllowPath = sources.profile?.alsoAllowPath;
    parts.push(
      alsoAllowPath
        ? `To add one tool, list it in ${alsoAllowPath}, or set ${profilePath} to "full".`
        : `To widen it, set ${profilePath} to "full".`,
    );
  }
  return parts.join(" ");
}

export function applySkipBootstrapConfig(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: { ...cfg.agents?.defaults, skipBootstrap: true },
    },
  };
}
