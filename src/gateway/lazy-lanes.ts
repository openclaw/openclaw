import { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
import type { loadConfig } from "../config/config.js";
import { registerLazyLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

/**
 * Register lazy concurrency resolvers for lanes that should be initialized on-demand.
 *
 * This avoids adding startup cost for lanes that may not be used immediately.
 * The resolvers will be called on first use of the lane.
 */
export function registerLazyGatewayLanes(cfg: ReturnType<typeof loadConfig>): void {
  // Register lazy resolver for Nested lane (used by sessions_send)
  // This avoids loading config parsing at startup for the Nested lane
  registerLazyLaneConcurrency(CommandLane.Nested, async () => {
    return resolveAgentMaxConcurrent(cfg);
  });
}
