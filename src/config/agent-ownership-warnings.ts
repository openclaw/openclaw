import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { listUnboundAmbientChannelIds } from "./legacy.default-agent-roles.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.openclaw.js";

/** Reports ownerless ambient surfaces without making the whole multi-agent config invalid. */
export function collectAgentOwnershipWarnings(
  cfg: OpenClawConfig,
  ambientChannelIds: readonly string[] = [],
): ConfigValidationIssue[] {
  const agents = listAgentEntries(cfg);
  if (agents.length <= 1) {
    return [];
  }
  const warnings: ConfigValidationIssue[] = [];
  for (const channelId of listUnboundAmbientChannelIds(cfg, ambientChannelIds)) {
    warnings.push({
      path: `channels.${channelId}`,
      message: `multi-agent inbound routing for ${channelId} has no channel-wide owner; run "openclaw agents bind --agent <id> --bind ${channelId}:*"`,
    });
  }
  const hasPerAgentHeartbeat = agents.some((entry) => Boolean(entry.heartbeat));
  const hasDefaultHeartbeat = cfg.agents?.defaults?.heartbeat !== undefined;
  if (!hasPerAgentHeartbeat && !hasDefaultHeartbeat) {
    warnings.push({
      path: "agents.defaults.heartbeat.agentId",
      message:
        "multi-agent ambient heartbeat scheduling has no owner; set agents.defaults.heartbeat.agentId",
    });
  }
  if (!normalizeOptionalString(cfg.agents?.defaults?.systemAgent?.agentId)) {
    warnings.push({
      path: "agents.defaults.systemAgent.agentId",
      message:
        "multi-agent system-agent consult routing has no owner; set agents.defaults.systemAgent.agentId",
    });
  }
  if (!normalizeOptionalString(cfg.talk?.agentId)) {
    warnings.push({
      path: "talk.agentId",
      message: "multi-agent Talk relay ownership is unset; set talk.agentId",
    });
  }
  return warnings;
}
