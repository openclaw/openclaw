import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { OpenClawStateReadOptions } from "../state/openclaw-state-read.types.js";
import type { ClawInventory } from "./inventory-read.kernel.js";

export async function readClawInventory(
  options: OpenClawStateDatabaseOptions = {},
  readOptions?: OpenClawStateReadOptions,
): Promise<ClawInventory> {
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "claws.inventory" },
    readOptions,
  );
  if (!reply) {
    return { installs: [], packages: [], workspaceFiles: [], mcpServers: [], cronJobs: [] };
  }
  return reply.inventory;
}
