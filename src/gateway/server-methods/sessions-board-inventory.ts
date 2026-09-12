import { listBoardSessionKeysReadOnly } from "../../boards/sqlite-board-store.js";
import type { GatewayStoredSessionTargets } from "../../config/sessions/combined-store-gateway.js";

export async function listBoardSessionKeys(
  targets: GatewayStoredSessionTargets,
): Promise<ReadonlySet<string>> {
  const inventories = new Map<string, ReadonlySet<string>>();
  const keys = new Set<string>();
  for (const [key, { storeKey, storeTarget }] of targets) {
    const identity = `${storeTarget.agentId}\0${storeTarget.storePath}`;
    let inventory = inventories.get(identity);
    if (!inventory) {
      inventory = await listBoardSessionKeysReadOnly({
        agentId: storeTarget.agentId,
        path: storeTarget.storePath,
      });
      inventories.set(identity, inventory);
    }
    // Equal sentinel keys in another store do not describe this selected row's board.
    if (inventory.has(storeKey ?? key)) {
      keys.add(key);
    }
  }
  return keys;
}
