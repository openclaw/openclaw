import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/search-manager.js";

const log = createSubsystemLogger("memory").child("qmd");

/**
 * QMD (memory sidecar) is lazily initialized by memory tool calls. After a gateway restart,
 * the in-memory manager and its interval timer are gone unless a memory tool is invoked.
 *
 * This boot hook eagerly creates the manager for the default agent (when configured),
 * which arms the periodic update/embed timer without changing the lazy tool-call path.
 */
export async function startGatewayMemoryBackendOnBoot(params: {
  cfg: OpenClawConfig;
}): Promise<void> {
  try {
    const agentId = resolveDefaultAgentId(params.cfg);
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (resolved.backend !== "qmd") {
      return;
    }

    const { manager, backend, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
    if (manager) {
      if (backend === "qmd") {
        log.info("initialized on boot");
        return;
      }
      log.warn("boot init failed, using builtin fallback", { error });
      return;
    }
    log.warn("failed to initialize on boot", { error: error ?? "unknown error" });
  } catch (err) {
    log.warn("failed to initialize on boot", { err });
  }
}
