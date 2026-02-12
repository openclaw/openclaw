import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/index.js";

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentId = resolveDefaultAgentId(params.cfg);
  const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
  if (resolved.backend !== "qmd" || !resolved.qmd) {
    return;
  }

  const { manager, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
  if (!manager) {
    params.log.warn(
      `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
    );
    return;
  }
  params.log.info?.(`qmd memory startup initialization armed for agent "${agentId}"`);
}
