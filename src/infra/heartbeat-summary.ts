/** @deprecated v4 reporting projection; ordinary jobs own cadence and delivery. */
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getPublishedHeartbeatSummary,
  type HeartbeatSummary,
} from "./heartbeat-summary-snapshot.js";

export type { HeartbeatSummary } from "./heartbeat-summary-snapshot.js";

export function resolveHeartbeatSummaryForAgent(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatSummary {
  const owner = agentId ?? tryResolveAmbientOwnerAgentId(cfg);
  return getPublishedHeartbeatSummary(cfg, owner);
}
