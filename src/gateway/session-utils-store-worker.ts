import { ok } from "@openclaw/normalization-core/result";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import type { GatewaySessionStoreDiscoveryCache } from "./session-utils-store-candidates.js";
import {
  prepareGatewaySessionStoreTargetReadOnly,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils-store-lookup.js";

/** Acquire the ordered lookup's data while its discovery and physical readers remain current. */
export async function resolveGatewaySessionStoreTargetInWorker(params: {
  cfg: OpenClawConfig;
  key: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  assertActive?: () => void;
}) {
  params.assertActive?.();
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg: params.cfg,
    sessionKey: params.key,
    agentId: params.agentId,
  });
  // Ephemeral databases belong to the process and cannot be opened by a worker.
  if (isIncognitoSessionKey(canonicalKey)) {
    return resolveGatewaySessionStoreTargetWithStore({
      ...params,
      agentId,
      readOnly: true,
      projection: "list",
      exactRead: true,
    });
  }
  const parsedAgent = parseAgentSessionKey(params.key)?.agentId;
  const { candidates, ...inventory } = prepareSessionStoreTargetInventory(
    params.cfg,
    [agentId, ...(parsedAgent ? [parsedAgent] : [])],
    params.env,
  );
  const inventoryRead = prepareSessionStoreTargetInventoryRead({ ...inventory, candidates });
  const target = await inventoryRead.withRead(async (sources, assertCurrent) => {
    const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
    for (const source of sources.agents) {
      if (!source.result.available && source.result.reason !== "database-missing") {
        throw new Error(`Session stores for agent ${source.agentId} are unavailable`);
      }
      targetDiscoveryCache.set(source.agentId, {
        existing: source.result.available ? source.result.targets : [],
        fallback: {
          agentId: source.agentId,
          storePath: inventory.paths.get(source.agentId)!.configured,
        },
      });
    }
    const selected = await prepareGatewaySessionStoreTargetReadOnly(
      {
        cfg: inventory.config,
        key: params.key,
        agentId,
        env: inventory.env,
        targetDiscoveryCache,
      },
      async (reads, select) => {
        assertCurrent();
        return await withSessionEntriesFromStoresInWorker(
          reads.map((read) => ({
            agentId: read.agentId ?? agentId,
            storePath: read.storePath,
            sessionKeys: read.options.exactKeys!,
            projection: "list",
            env: inventory.env,
          })),
          (loaded) => {
            assertCurrent();
            for (const [index, read] of reads.entries()) {
              const prepared = loaded[index]!;
              read.result = ok(
                Object.fromEntries(
                  prepared.result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
                ),
              );
              read.readSource = {
                agentId: prepared.database.agentId,
                path: prepared.database.path,
              };
            }
            return select();
          },
        );
      },
    );
    assertCurrent();
    return selected;
  }, params.assertActive);
  params.assertActive?.();
  return target;
}
