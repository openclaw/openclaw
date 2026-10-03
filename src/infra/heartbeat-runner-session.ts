/** @deprecated Status-only v4 projection. This module never creates or repairs sessions. */
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatSummaryForAgent } from "./heartbeat-summary.js";

export function resolveHeartbeatSessionKey(
  cfg: OpenClawConfig,
  agentId: string,
  projected?: { session?: string },
) {
  return {
    sessionKey:
      projected?.session ??
      resolveHeartbeatSummaryForAgent(cfg, agentId).session ??
      resolveAgentMainSessionKey({ cfg, agentId }),
    storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    suppressOriginatingContext: false,
  };
}
