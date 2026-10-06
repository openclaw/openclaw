import fs from "node:fs/promises";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  historyLane,
  historyPageLane,
  maintenanceLane,
  selectSessionHistoryReadLane,
} from "../config/sessions/session-transcript-worker-resources.js";
import {
  isSessionHistoryWorkerCold,
  prewarmSessionHistoryWorker,
} from "../config/sessions/session-transcript-worker-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets-configured-agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errno.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway");

export async function prewarmGatewaySessionHistory(
  config: OpenClawConfig,
  options: {
    onlyIfCold?: boolean;
    includeRequesterReaders?: boolean;
    isCancelled?: () => boolean;
  } = {},
): Promise<void> {
  const lanes = options.includeRequesterReaders
    ? [
        historyPageLane,
        historyLane,
        selectSessionHistoryReadLane("transcript-hydration"),
        maintenanceLane,
      ]
    : [historyPageLane];
  try {
    if (options.onlyIfCold && !lanes.some((lane) => isSessionHistoryWorkerCold(lane))) {
      return;
    }
    for (const agentId of listConfiguredSessionStoreAgentIds(config)) {
      if (options.isCancelled?.()) {
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
        if (exists) {
          const target = { ...database, agentId: database.agentId ?? agentId };
          for (const lane of lanes) {
            if (options.isCancelled?.()) {
              return;
            }
            await prewarmSessionHistoryWorker(target, lane);
          }
        }
      } catch (error) {
        log.debug(`Session history prewarm failed for ${agentId}: ${String(error)}`);
      }
    }
  } catch (error) {
    log.debug(`Session history prewarm failed: ${String(error)}`);
  }
}
