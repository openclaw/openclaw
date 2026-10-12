import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionStoreRegistryRead } from "./session-sqlite-target.js";
import { prepareSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "./session-store-target-runtime.js";
import type { SessionStoreTarget } from "./targets-collision.js";
import { listConfiguredSessionStoreAgentIds } from "./targets-configured-agents.js";

/** Discover configured and retired stores in the existing read worker. */
export async function resolveAllAgentSessionStoreTargetsAsync(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv; registeredDatabases?: SessionStoreRegistryRead } = {},
): Promise<SessionStoreTarget[]> {
  const request = prepareSessionStoreTargetInventory(
    cfg,
    listConfiguredSessionStoreAgentIds(cfg),
    options.env,
    "recovery",
  );
  return prepareSessionStoreTargetInventoryRead(
    request,
    undefined,
    options.registeredDatabases,
  ).withRead(async (inventory) =>
    inventory.agents.flatMap(({ result }) => (result.available ? result.targets : [])),
  );
}

/** Resolve the reaper's roster through the same discovery owner as session reads. */
export async function listKnownSessionStoreAgentIdsAsync(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  const request = prepareSessionStoreTargetInventory(
    cfg,
    listConfiguredSessionStoreAgentIds(cfg),
    options.env,
    "known-owners",
  );
  return prepareSessionStoreTargetInventoryRead(request).withRead(async (inventory) =>
    inventory.agents.map(({ agentId }) => agentId),
  );
}

/** Keep unavailable storage distinct from an absent owner; callers must not infer deletion. */
export async function resolveExistingAgentSessionStoreTargetsAsync(
  cfg: OpenClawConfig,
  agentId: string,
  options: { env?: NodeJS.ProcessEnv; excludeStorePath?: string } = {},
): Promise<SessionStoreTarget[]> {
  const request = prepareSessionStoreTargetInventory(cfg, [agentId], options.env);
  return prepareSessionStoreTargetInventoryRead(request).withRead(async (inventory) => {
    const selected = inventory.agents[0];
    if (
      !selected ||
      (!selected.result.available && selected.result.reason === "database-missing")
    ) {
      return [];
    }
    if (!selected.result.available) {
      throw new Error(`Session store discovery failed (${selected.result.reason})`);
    }
    return selected.result.targets.filter(
      (target) => target.storePath !== options.excludeStorePath,
    );
  });
}
