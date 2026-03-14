import { listAgentIds } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-runner.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/index.js";

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  for (const agentId of agentIds) {
    // Only warm up QMD for agents with an active heartbeat — they run on a
    // schedule and need memory search ready without a user request to
    // trigger lazy init. All other agents initialize on first use.
    const hb = resolveHeartbeatSummaryForAgent(params.cfg, agentId);
    if (!hb.enabled || hb.everyMs === null) {
      continue;
    }
    if (!resolveMemorySearchConfig(params.cfg, agentId)) {
      continue;
    }
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (resolved.backend !== "qmd" || !resolved.qmd) {
      continue;
    }

    const { manager, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
    if (!manager) {
      params.log.warn(
        `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    params.log.info?.(`qmd memory startup initialization armed for agent "${agentId}"`);
  }
}
