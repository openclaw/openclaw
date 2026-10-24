import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import type { SessionStoreTarget } from "../config/sessions/targets-collision.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets-configured-agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";

/** Question custody uses the configured physical stores, never retired generic restart owners. */
export async function discoverQuestionRecoveryStoreTargets(params: {
  cfg: OpenClawConfig;
  stateDir?: string;
  agentIds?: ReadonlySet<string>;
  onUnavailable?: (target: SessionStoreTarget, error: unknown) => void;
}): Promise<SessionStoreTarget[]> {
  const env = params.stateDir
    ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir }
    : process.env;
  const agentIds = listConfiguredSessionStoreAgentIds(params.cfg).filter(
    (id) => !params.agentIds || params.agentIds.has(id),
  );
  const inventory = prepareSessionStoreTargetInventory(params.cfg, agentIds, env, "configured");
  for (const agentId of agentIds) {
    const refusal = readAgentDatabaseAdmissionRefusal(agentId, { env });
    if (refusal) {
      for (const storePath of refusal.paths) {
        params.onUnavailable?.({ agentId, storePath }, { refusal });
      }
    }
  }
  return prepareSessionStoreTargetInventoryRead(inventory).withRead(async (snapshot) =>
    snapshot.agents.flatMap(({ agentId, result, reads }) => {
      if (!result.available) {
        if (result.reason !== "database-missing") {
          params.onUnavailable?.(
            {
              agentId,
              storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId, env }),
            },
            result,
          );
        }
        return [];
      }
      return reads.map(({ target, database }) => ({ ...target, storePath: database.path }));
    }),
  );
}
