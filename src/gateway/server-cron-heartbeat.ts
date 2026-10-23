import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";

export function sanitizeCronHeartbeatOverride(
  heartbeat: AgentDefaultsConfig["heartbeat"] | undefined,
): AgentDefaultsConfig["heartbeat"] | undefined {
  return heartbeat?.target === "last"
    ? { ...heartbeat, to: undefined, accountId: undefined }
    : heartbeat;
}
