import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { resolveAgentConfig } from "./agent-scope.js";

/**
 * Resolves tool-loop detection settings for an agent, layering agent config on
 * top of global tool config while preserving nested detector/guard defaults.
 */
export function resolveToolLoopDetectionConfig(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): ToolLoopDetectionConfig | undefined {
  const global = params.cfg?.tools?.loopDetection;
  const agent =
    params.agentId && params.cfg
      ? resolveAgentConfig(params.cfg, params.agentId)?.tools?.loopDetection
      : undefined;

  if (!agent) {
    return global;
  }
  if (!global) {
    return agent;
  }

  // Detectors and post-compaction guard are independent nested namespaces; a
  // shallow spread would drop global defaults when an agent overrides one key.
  return {
    ...global,
    ...agent,
    detectors: {
      ...global.detectors,
      ...agent.detectors,
    },
    postCompactionGuard: {
      ...global.postCompactionGuard,
      ...agent.postCompactionGuard,
    },
  };
}
