import { listAgentIds } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActiveMemorySearchManager,
  resolveActiveMemoryBackendConfig,
} from "../plugins/memory-runtime.js";

const QMD_STARTUP_INIT_LABEL = "qmd memory startup initialization";
const BUILTIN_LOCAL_PREWARM_LABEL = "builtin local memory startup prewarm";

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  const armedAgentIds: string[] = [];
  for (const agentId of agentIds) {
    const memorySearchConfig = resolveMemorySearchConfig(params.cfg, agentId);
    if (!memorySearchConfig) {
      continue;
    }
    const resolved = resolveActiveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (!resolved) {
      continue;
    }

    const shouldInitializeQmd = resolved.backend === "qmd" && Boolean(resolved.qmd);
    const shouldPrewarmBuiltinLocal =
      resolved.backend === "builtin" && memorySearchConfig.provider === "local";
    if (!shouldInitializeQmd && !shouldPrewarmBuiltinLocal) {
      continue;
    }

    const { manager, error } = await getActiveMemorySearchManager({ cfg: params.cfg, agentId });
    if (!manager) {
      params.log.warn(
        `${shouldInitializeQmd ? QMD_STARTUP_INIT_LABEL : BUILTIN_LOCAL_PREWARM_LABEL} failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }

    if (shouldInitializeQmd) {
      armedAgentIds.push(agentId);
      continue;
    }

    try {
      const probe = await manager.probeEmbeddingAvailability();
      if (!probe.ok) {
        params.log.warn(
          `${BUILTIN_LOCAL_PREWARM_LABEL} failed for agent "${agentId}": ${probe.error ?? "unknown error"}`,
        );
        continue;
      }
      params.log.info?.(`${BUILTIN_LOCAL_PREWARM_LABEL} completed for agent "${agentId}"`);
    } catch (err) {
      params.log.warn(
        `${BUILTIN_LOCAL_PREWARM_LABEL} failed for agent "${agentId}": ${String(err)}`,
      );
    }
  }
  if (armedAgentIds.length > 0) {
    params.log.info?.(
      `${QMD_STARTUP_INIT_LABEL} armed for ${formatAgentCount(armedAgentIds.length)}: ${armedAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
}

function formatAgentCount(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}
