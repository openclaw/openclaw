/**
 * Sandbox agent config fixtures.
 *
 * Builds restricted agent configs for sandbox tool-policy and workspace tests.
 */
import type { AgentConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type AgentToolsConfig = AgentConfig["tools"];
type SandboxToolsConfig = {
  allow?: string[];
  deny?: string[];
};

export function createRestrictedAgentSandboxConfig(params: {
  agentTools?: AgentToolsConfig;
  globalSandboxTools?: SandboxToolsConfig;
  workspace?: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "agent",
        },
      },
      entries: {
        restricted: {
          workspace: params.workspace ?? "~/openclaw-restricted",
          sandbox: {
            mode: "all",
            scope: "agent",
          },
          ...(params.agentTools ? { tools: params.agentTools } : {}),
        },
      },
    },
    ...(params.globalSandboxTools
      ? {
          tools: {
            sandbox: {
              tools: params.globalSandboxTools,
            },
          },
        }
      : {}),
  } as OpenClawConfig;
}
