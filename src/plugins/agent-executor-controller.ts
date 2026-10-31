import type { AgentExecutorController } from "./agent-executor-controller.types.js";
import { PluginCapabilityRemovedError } from "./removed-capability-error.js";

/** Retained for published AgentsAPI imports; controller ownership cannot be recreated. */
export function resolveAgentExecutorController(pluginId: string): AgentExecutorController {
  throw new PluginCapabilityRemovedError(
    "api.registerAgentExecutorController",
    `Executor controller "${pluginId}" is unavailable. Retire or migrate its saved AgentsAPI sessions with the previous host before switching to an externally managed self_hosted environment.`,
  );
}
