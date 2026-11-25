import fs from "node:fs/promises";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { prewarmSessionHistoryWorker } from "../config/sessions/session-transcript-worker-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets-configured-agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isMemoryPressureHigh } from "../infra/host-memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway");

export async function prewarmGatewaySessionHistory(
  config: OpenClawConfig,
  options: {
    isCancelled?: () => boolean;
  } = {},
): Promise<void> {
  // Operator attach can also request this warmup independently of the startup scheduler.
  const shouldStop = () => options.isCancelled?.() || isMemoryPressureHigh();
  try {
    for (const agentId of listConfiguredSessionStoreAgentIds(config)) {
      if (shouldStop()) {
        return;
      }
      try {
        const storePath = resolveSessionStorePathCore(config.session?.store, { agentId });
        const database = await prepareSqliteTargetFromSessionStorePath(storePath, {
          agentId,
          defaultAgentId: resolveSessionStoreCompatibilityAgentId(config),
        });
        const exists = await fs.stat(database.path).then(
          (stat) => stat.isFile(),
          (error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return false;
            }
            throw error;
          },
        );
        if (exists && !shouldStop()) {
          await prewarmSessionHistoryWorker({ ...database, agentId: database.agentId ?? agentId });
        }
      } catch (error) {
        log.debug(`Session history prewarm failed for ${agentId}: ${String(error)}`);
      }
    }
  } catch (error) {
    log.debug(`Session history prewarm failed: ${String(error)}`);
  }
}
