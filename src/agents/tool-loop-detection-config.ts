import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { resolveAgentConfig } from "./agent-scope.js";

/** Resolve loop detection config with agent overrides layered over global tool settings. */
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

  return {
    ...global,
    ...agent,
    // Nested knobs merge independently so an agent can override one detector without clearing siblings.
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
