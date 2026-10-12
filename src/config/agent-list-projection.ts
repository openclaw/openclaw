import { listAgentEntries } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "./types.js";

/**
 * @deprecated Untyped, non-enumerable SDK compatibility for third-party plugins built
 * against releases through 2026.9.x; internal code must not read this projection.
 * Remove after 2027-01-02. Use canonical cfg.agents.entries, or listAgentIds /
 * resolveAgentConfig from openclaw/plugin-sdk/agent-runtime instead.
 */
export function attachAgentListProjection(config: OpenClawConfig): OpenClawConfig {
  const agents = config.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    return config;
  }
  Object.defineProperty(agents, "list", {
    configurable: true,
    enumerable: false,
    value: listAgentEntries(config),
    writable: false,
  });
  return config;
}
